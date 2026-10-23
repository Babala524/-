import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { demand, Fault, inside, atomic, exec, walk, sha, humanSize, timeString, jsonRead, identifier } from './core.mjs';
import { lua, staticLuaTable, levelData, savedLevelSource, presets } from './lua.mjs';
import { SaveTransaction } from './save-transaction.mjs';

export class Saves {
  constructor(store, runtime, mods=null) {
    this.store=store; this.runtime=runtime; this.config=store.config; this.mods=mods;
    this.recovery=Promise.all(SaveTransaction.pending(store).map(async transaction=>{
      const id=transaction.record.id;store.locks.add(id);
      try{
        if(transaction.record.phase==='committed')transaction.cleanup();
        else { await runtime.stop(id);transaction.rollback();store.event(id,'服务重启后已自动恢复原存档，请手动启动游戏'); }
        store.locks.delete(id);
      }catch(error){store.restoreBlocked??=new Set();store.restoreBlocked.add(id);store.event(id,'存档恢复保护：自动回滚未完成，已保留原存档并锁定房间：'+error.message);}
    }));
  }
  directory(id) { return inside(this.config.data, `backups/${identifier(id)}`); }
  syncRoomMods(id, room = this.store.getRoom(id), root=this.store.cluster(id)) {
    const source='return '+lua(Object.fromEntries(room.mods.filter(mod=>mod.enabled).map(mod=>['workshop-'+mod.id,{enabled:true,configuration_options:mod.config}])))+'\n';
    for(const world of room.worlds) atomic(inside(root,path.join(world.directory,'modoverrides.lua')),source);
  }
  importModsFromCluster(id, root, room) {
    const merged = new Map();
    const files = walk(root).filter(file => path.basename(file) === 'modoverrides.lua');
    for (const file of files) {
      let parsed;
      try { parsed = staticLuaTable(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/,'').replace(/^KLEI {5}1 /,'')); }
      catch { throw new Fault(400,`世界 ${path.basename(path.dirname(file))} 模组配置读取失败，已取消恢复并保留原存档`); }
      demand(parsed && typeof parsed === 'object' && (!Array.isArray(parsed)||parsed.length===0),'存档模组配置无效，已取消恢复',400);
      for (const [key, value] of Object.entries(parsed)) {
        const match = String(key).match(/^workshop-(\d{6,20})$/); if (!match || !value || typeof value !== 'object') continue;
        const id = match[1], existing = merged.get(id) || { id, name:`Workshop ${id}`, source:'imported', enabled:false, config:{} };
        existing.enabled = value.enabled !== false;
        if (value.configuration_options && typeof value.configuration_options === 'object' && !Array.isArray(value.configuration_options)) existing.config = { ...existing.config, ...value.configuration_options };
        merged.set(id, existing);
      }
    }
    return [...merged.values()];
  }
  readIni(file) {
    const result={}; if(!fs.existsSync(file))return result;
    let section=''; for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const text=line.trim();if(!text||text.startsWith(';')||text.startsWith('#'))continue;if(/^\[.*\]$/.test(text)){section=text.slice(1,-1).trim().toUpperCase();result[section]??={};continue;}const match=text.match(/^([^=]+?)\s*=\s*(.*)$/);if(match)result[section]??={},result[section][match[1].trim().toLowerCase()]=match[2].trim();}
    return result;
  }
  importRoomFromCluster(id, root, previous) {
    const clusterFile=walk(root).find(file=>path.basename(file).toLowerCase()==='cluster.ini');
    demand(clusterFile,'存档缺少 cluster.ini',400); const clusterDir=path.dirname(clusterFile), cluster=this.readIni(clusterFile), gameplay=cluster.GAMEPLAY||{}, network=cluster.NETWORK||{};
    const worlds=[];
    for(const dir of fs.readdirSync(clusterDir,{withFileTypes:true}).filter(entry=>entry.isDirectory())){
      const serverFile=path.join(clusterDir,dir.name,'server.ini'); if(!fs.existsSync(serverFile))continue;
      demand(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(dir.name),`存档世界目录不合法：${dir.name}`,400);
      const ini=this.readIni(serverFile),networkWorld=ini.NETWORK||{};
      const levelFile=['leveldataoverride.lua','worldgenoverride.lua'].map(name=>path.join(clusterDir,dir.name,name)).find(file=>fs.existsSync(file));
      let source=null,data=null;
      if(levelFile)try{source=savedLevelSource(fs.readFileSync(levelFile,'utf8'));data=levelData(source);}catch(error){throw new Fault(400,`世界 ${dir.name} 配置读取失败：${error.message}；未恢复存档`);}
      const location=String(data?.location||data?.overrides?.location||'').toLowerCase();
      const type=/^caves?$/.test(location)||data?.id==='DST_CAVE'?'caves':location==='forest'?'forest':/cave/i.test(dir.name)?'caves':'forest';
      source??=presets[previous.mode]?.[type==='caves'?'caves':'master']||presets.endless[type==='caves'?'caves':'master'];
      worlds.push({directory:dir.name,type,port:Number(networkWorld.server_port||0),levelData:source,_master:ini.SHARD?.is_master,_steam:[Number(ini.STEAM?.master_server_port),Number(ini.STEAM?.authentication_port)]});
    }
    worlds.sort((a,b)=>{const rank=w=>/^(true|1)$/i.test(w._master||'')?0:/^(false|0)$/i.test(w._master||'')?2:w.directory.toLowerCase()==='master'?0:1;return rank(a)-rank(b)||a.directory.localeCompare(b.directory);});
    const importedPorts=[Number(cluster.SHARD?.master_port),...worlds.flatMap(world=>world._steam)];
    for(const world of worlds){delete world._master;delete world._steam;}
    demand(worlds.length>0,'存档没有有效世界配置',400); demand(worlds.every(world=>Number.isInteger(world.port)&&world.port>=1024&&world.port<=65535),'存档世界端口无效',400);
    demand(worlds.length<=8,'存档世界数量超过 8 层，无法完整恢复',400);
    demand(new Set(worlds.map(world=>world.port)).size===worlds.length,'存档世界直连端口重复',400);
    const modeMap={endless:'endless',survival:'survival',relaxed:'relaxed',wilderness:'wilderness',lightsout:'lightsOut',lights_out:'lightsOut',lavaarena:'lavaarena',quagmire:'quagmire'};
    const imported={...previous,name:String(network.cluster_name||previous.name).slice(0,40),password:String(network.cluster_password||''),maxPlayers:Math.min(64,Math.max(1,Number(gameplay.max_players)||previous.maxPlayers)),pvp:/^(true|1)$/i.test(gameplay.pvp||''),pause:/^(true|1)$/i.test(gameplay.pause_when_empty||''),vote:/^(true|1)$/i.test(gameplay.vote_enabled||''),mode:modeMap[String(gameplay.game_mode||'').toLowerCase()]||previous.mode,worlds:worlds.slice(0,8),worldCount:Math.min(8,worlds.length)};
    if(importedPorts.every(port=>Number.isInteger(port)&&port>=1024&&port<=65535)&&new Set(importedPorts).size===importedPorts.length&&!worlds.some(world=>importedPorts.includes(world.port)))imported._ports=importedPorts;
    if(cluster.SHARD?.cluster_key)imported._clusterKey=cluster.SHARD.cluster_key;
    imported.description=String(network.cluster_description||'').slice(0,256);
    imported.mods=this.importModsFromCluster(id,clusterDir,previous); return imported;
  }
  list(id) {
    this.store.getRoom(id);
    const directory=this.directory(id);
    if(!fs.existsSync(directory)) return {rows:[]};
    return {rows:fs.readdirSync(directory).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).map(name=>jsonRead(inside(directory,name))).filter(Boolean).sort((a,b)=>b.time.localeCompare(a.time))};
  }
  record(id,file,name,source,worlds) {
    const saveID=crypto.randomUUID(), directory=this.directory(id); fs.mkdirSync(directory,{recursive:true});
    const destination=inside(directory,saveID+path.extname(file)); fs.renameSync(file,destination);
    const entry={id:saveID,name,world:worlds.join(' / '),time:timeString(Date.now()),size:humanSize(fs.statSync(destination).size),source,file:path.basename(destination)};
    atomic(inside(directory,saveID+'.json'),JSON.stringify(entry)); return entry;
  }
  download(id, saveID) {
    const entry = this.list(id).rows.find(row => row.id === String(saveID));
    demand(entry, '存档不存在或已过期', 404);
    const file = inside(this.directory(id), entry.file);
    demand(fs.existsSync(file) && fs.statSync(file).isFile(), '存档文件不存在', 404);
    return { entry, file };
  }
  remove(id, saveIDs) {
    this.store.getRoom(id);
    demand(Array.isArray(saveIDs) && saveIDs.length > 0 && saveIDs.length <= 100, '请选择要删除的存档');
    const wanted = new Set(saveIDs.map(value => String(value)));
    const rows = this.list(id).rows.filter(row => wanted.has(row.id));
    demand(rows.length === wanted.size, '部分存档不存在或已过期', 404);
    for (const row of rows) {
      fs.rmSync(inside(this.directory(id), row.file), { force: true });
      fs.rmSync(inside(this.directory(id), `${row.id}.json`), { force: true });
    }
    this.store.event(id, `已删除 ${rows.length} 个存档`);
    return { deleted: rows.length };
  }
  async backup(id,{resume=true,name=null}={}) {
    const room=this.store.getRoom(id), originally=(await this.runtime.status(id)).filter(world=>world.running);
    if(originally.length) await this.runtime.stop(id);
    const temp=inside(this.config.data,'tmp/backup-'+crypto.randomUUID()+'.zip'); fs.mkdirSync(path.dirname(temp),{recursive:true});
    try {
      const cluster=this.store.cluster(id); walk(cluster); // Reject symlinks before the archiver traverses files.
      const script='import sys,zipfile,pathlib; root=pathlib.Path(sys.argv[1]); out=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [out.write(p,p.relative_to(root)) for p in root.rglob("*") if p.is_file()]; out.close()';
      await exec(this.config.python,['-c',script,cluster,temp],{timeout:300000});
      const entry=this.record(id,temp,name||`手动备份 ${timeString(Date.now())}`,'backup',room.worlds.map(world=>world.directory));
      this.store.event(id,'房间备份已生成'); return {backedUp:true,save:entry};
    } finally {
      fs.rmSync(temp,{force:true});
      if(resume&&originally.length) await this.runtime.start(id,originally.map(world=>world.directory));
    }
  }
  async upload(id,file,name) {
    this.store.getRoom(id); demand(fs.existsSync(file),'上传文件不存在');
    const staging=inside(this.config.data,'tmp/extract-'+crypto.randomUUID());
    try {
      try { await exec(this.config.python,[path.join(this.config.root,'backend/scripts/archive.py'),'extract',file,staging,String(this.config.extractLimit)],{timeout:120000,maxBuffer:1048576}); }
      catch(error) { throw new Fault(400,(error.stderr||error.message||'存档校验失败').trim().slice(0,400)); }
      const metadata=JSON.parse((await exec(this.config.python,['-c','import sys,pathlib,json; p=next(pathlib.Path(sys.argv[1]).rglob("cluster.ini")).parent;print(json.dumps([x.name for x in p.iterdir() if x.is_dir() and (x/"server.ini").is_file()]))',staging])).stdout);
      const entry=this.record(id,file,name.slice(0,160),'upload',metadata);
      this.store.event(id,`已上传存档：${entry.name}`); return {uploaded:true,save:entry};
    } finally { fs.rmSync(staging,{recursive:true,force:true}); fs.rmSync(file,{force:true}); }
  }
  async restore(id, saveID, report=()=>{}) {
    const { entry, file } = this.download(id, saveID), room = this.store.getRoom(id);
    const wasRunning = (await this.runtime.status(id)).filter(world => world.running).map(world => world.directory);
    const staging = inside(this.config.data, `tmp/restore-save-${crypto.randomUUID()}`);
    const transaction=SaveTransaction.create(this.store,id,room),prepared=transaction.prepared;
    let swapping=false,stopped=false;
    let safety;
    try {
      // Validate and download before stopping the current game. Steam outages
      // must not take a healthy room offline just to prepare an import.
      report(null,'正在校验存档和世界配置',{stage:'validating'});
      await exec(this.config.python, [path.join(this.config.root,'backend/scripts/archive.py'),'extract',file,staging,String(this.config.extractLimit)], {timeout:120000,maxBuffer:1048576});
      const clusterRoot = JSON.parse((await exec(this.config.python,['-c','import sys,pathlib,json; p=next(pathlib.Path(sys.argv[1]).rglob("cluster.ini")).parent; print(json.dumps(str(p)))',staging])).stdout);
      const importedRoom = this.importRoomFromCluster(id, clusterRoot, room);
      const importedMods = importedRoom.mods;
      const missing = importedMods.filter(mod=>mod.enabled && (!this.mods || !this.mods.find(mod.id))).map(mod=>mod.id);
      if(missing.length){ demand(this.mods,'模组服务不可用，无法下载存档模组',503); await this.mods.ensureInstalled(id,missing,report); }
      // Prepare and validate the complete replacement before touching the live cluster.
      fs.mkdirSync(prepared,{recursive:true});
      for (const name of fs.readdirSync(clusterRoot)) fs.cpSync(path.join(clusterRoot,name),path.join(prepared,name),{recursive:true,errorOnExist:true});
      for (const world of importedRoom.worlds) atomic(inside(prepared,path.join(world.directory,'leveldataoverride.lua')),world.levelData);
      this.syncRoomMods(id,importedRoom,prepared);
      const unresolved=importedMods.filter(mod=>mod.enabled && (!this.mods || !this.mods.find(mod.id))).map(mod=>mod.id);
      demand(!unresolved.length,`存档模组下载失败：${unresolved.join('、')}`,409);
      report(null,'模组和配置已就绪，正在备份当前房间',{stage:'backup'});
      stopped=true;safety=await this.backup(id,{resume:false,name:'存档恢复前自动备份'});
      demand(!(await this.runtime.status(id)).some(world=>world.running),'游戏尚未关闭，已取消存档替换',409);
      report(null,'正在完整替换存档、房间和模组配置',{stage:'applying'});
      swapping=true;transaction.swap(importedRoom);
      if(wasRunning.length)await this.runtime.start(id);
      transaction.commit();
      try{transaction.cleanup();}catch{this.store.event(id,'存档已恢复，临时文件将在服务重启后清理');}
      this.store.event(id,`已恢复存档：${entry.name}`);
      return {restored:true,saveID:entry.id,backupID:safety.save.id,importedMods:importedMods.map(mod=>mod.id),downloadedMods:missing};
    } catch (error) {
      // A failed start or write must leave the previous room usable. The safety backup
      // remains available for manual recovery, while this transaction restores files
      // and the database row automatically when the swap already happened.
      if(swapping&&transaction.record.phase!=='committed'){
        try{await this.runtime.stop(id);transaction.rollback();}
        catch(rollbackError){
          // Keep both the journal and all old files. A separate guard survives
          // locked()'s finally and prevents a start against mismatched data.
          this.store.restoreBlocked??=new Set();this.store.restoreBlocked.add(String(id));
          throw new Fault(500,`恢复失败且自动回滚未完成，原存档已保留，请勿继续启动：${rollbackError.message}`);
        }
      }
      if(transaction.record.phase!=='committed'&&stopped&&wasRunning.length)try{await this.runtime.start(id,wasRunning);}catch(resumeError){throw new Fault(502,`${error.message}；原存档已保留，但原房间重启失败：${resumeError.message}`);}
      throw error;
    } finally {
      fs.rmSync(staging,{recursive:true,force:true});
      if(!fs.existsSync(transaction.file))fs.rmSync(prepared,{recursive:true,force:true});
    }
  }
  snapshots(id) {
    const room=this.store.getRoom(id), rows=[];
    room.worlds.forEach(world=>{
      const base=inside(this.store.cluster(id),`${world.directory}/save/session`);
      if(!fs.existsSync(base)) return;
      // Player snapshots live below an extra directory; list world snapshots only.
      const sessions=fs.readdirSync(base,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^[A-Fa-f0-9]{8,32}$/.test(entry.name)).map(entry=>({name:entry.name,path:inside(base,entry.name)}));
      sessions.sort((a,b)=>fs.statSync(b.path).mtimeMs-fs.statSync(a.path).mtimeMs);
      const latest=sessions[0]; if(!latest) return;
      for(const file of fs.readdirSync(latest.path)) {
        if(!/^\d{1,16}$/.test(file)) continue;
        const target=inside(latest.path,file); if(!fs.statSync(target).isFile()) continue;
        const stat=fs.statSync(target), relative=path.relative(this.store.cluster(id),target).split(path.sep).join('/');
        const meta=target+'.meta', text=fs.existsSync(meta)?fs.readFileSync(inside(latest.path,file+'.meta'),'utf8').slice(0,1048576):'';
        const cycles=text.match(/\bcycles\s*=\s*(\d+)/), day=cycles?Number(cycles[1])+1:null;
        rows.push({id:sha(world.directory+':'+relative).slice(0,32),name:file,worldID:world.directory,world:`${world.directory} · ${world.type==='caves'?'洞穴':'森林'}`,day,time:timeString(stat.mtimeMs),size:humanSize(stat.size),relative,sequence:Number(file)});
      }
    });
    return rows.sort((a,b)=>b.time.localeCompare(a.time));
  }
  async restoreSnapshot(id,snapshotID,worldID) {
    let rows=this.snapshots(id), selected=rows.find(row=>row.id===snapshotID&&row.worldID===worldID);
    demand(selected,'快照不存在或已过期',404);
    const room=this.store.getRoom(id);
    demand(selected.day!==null,'无法确定快照游戏天数，不能安全协调世界恢复',409);
    const targets=room.worlds.map(world=>{
      const candidates=rows.filter(row=>row.worldID===world.directory&&row.day===selected.day).sort((a,b)=>b.sequence-a.sequence);
      demand(candidates.length,`世界 ${world.directory} 缺少同一天快照，无法恢复`,409);
      return world.directory===selected.worldID?selected:candidates[0];
    });
    const wasRunning=(await this.runtime.status(id)).filter(world=>world.running).map(world=>world.directory);
    // A complete backup is retained before any snapshot or player data is touched.
    const backup=await this.backup(id,{resume:false,name:'快照恢复前自动备份'});
    const quarantine=inside(this.config.data,'tmp/restore-'+crypto.randomUUID()), removed=[];
    fs.mkdirSync(quarantine,{recursive:true});
    try {
      rows=this.snapshots(id);
      for(const target of targets) {
        demand(rows.some(row=>row.id===target.id),'恢复目标已变化，请刷新后重试',409);
        const selectedPath=inside(this.store.cluster(id),target.relative), session=path.dirname(selectedPath);
        for(const file of walk(session)) {
          const name=path.basename(file), number=name.match(/^(\d+)(?:\.meta)?$/)?.[1];
          if(!number||Number(number)<=target.sequence) continue;
          const relative=path.relative(this.store.cluster(id),file), destination=inside(quarantine,relative);
          fs.mkdirSync(path.dirname(destination),{recursive:true}); fs.renameSync(file,destination); removed.push([file,destination]);
        }
      }
    } catch(error) { for(const [file,destination] of removed.reverse()){fs.mkdirSync(path.dirname(file),{recursive:true});fs.renameSync(destination,file);} throw error; }
    finally { fs.rmSync(quarantine,{recursive:true,force:true}); }
    this.syncRoomMods(id, room);
    if(wasRunning.length) await this.runtime.start(id);
    this.store.event(id,`已恢复所有世界至第 ${selected.day} 天快照`);
    return {restored:true,backupID:backup.save.id,day:selected.day};
  }
  async scheduledRestart(id) {
    const room=this.store.getRoom(id),running=(await this.runtime.status(id)).filter(world=>world.running).map(world=>world.directory);
    if(!running.length){this.store.event(id,'定时重启已跳过：房间已关闭');return {skipped:true,reason:'stopped'};}
    demand(!this.store.sharedBusy,'共享游戏文件正在更新，无法定时重启',409);
    for(const mod of room.mods.filter(mod=>mod.enabled))demand(fs.existsSync(inside(this.config.game,'mods/workshop-'+mod.id+'/modinfo.lua')),'启用模组尚未安装，已取消定时重启',409);
    const stopped=await this.runtime.stop(id,running);
    demand(stopped.stopped,'世界未确认关闭，已取消重启',502);
    const result=await this.runtime.start(id,running);
    await new Promise(resolve=>setTimeout(resolve,500));
    const current=await this.runtime.status(id);
    demand(running.every(directory=>current.some(world=>world.directory===directory&&world.running)),'定时重启后有世界未能保持运行，请检查游戏日志',502);
    this.store.event(id,`定时重启已发送启动请求：${running.join('、')}`);
    return {...result,restarted:true,worlds:running};
  }
  async tick(at=new Date()) {
    if(this.store.sharedBusy)return;
    const now=new Intl.DateTimeFormat('en-CA',{timeZone:this.config.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);
    const parts=Object.fromEntries(now.map(part=>[part.type,part.value]));
    const time=`${parts.hour}:${parts.minute}`,day=`${parts.year}-${parts.month}-${parts.day}`;
    for(const room of this.store.rooms()) {
      if(this.store.locks.has(room.id))continue;
      const backup=room.automation.autoBackup&&room.automation.backupTime===time&&this.store.db.prepare('SELECT day FROM schedule WHERE room=?').get(room.id)?.day!==day;
      const restart=room.automation.autoRestart===true&&room.automation.restartTime===time&&this.store.db.prepare('SELECT day FROM schedule_runs WHERE room=? AND kind=?').get(room.id,'restart')?.day!==day;
      if(!backup&&!restart)continue;
      if(backup)this.store.db.prepare('INSERT INTO schedule VALUES(?,?) ON CONFLICT(room) DO UPDATE SET day=excluded.day').run(room.id,day);
      if(restart)this.store.db.prepare('INSERT INTO schedule_runs VALUES(?,?,?) ON CONFLICT(room,kind) DO UPDATE SET day=excluded.day').run(room.id,'restart',day);
      this.store.task(backup&&restart?'定时备份并重启':backup?'定时备份':'定时重启',room.id,()=>this.store.locked(room.id,async()=>{
        demand(!this.store.sharedBusy,'共享游戏文件正在更新，已跳过定时任务',409);
        if(backup){
          // A running backup already stops and restarts exactly the active shards.
          const result=await this.backup(room.id,{name:`定时备份 ${day} ${time}`});
          return {...result,restartIncluded:restart};
        }
        return this.scheduledRestart(room.id);
      }));
    }
  }
}
