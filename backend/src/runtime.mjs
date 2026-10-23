import fs from 'node:fs';
import path from 'node:path';
import { demand, inside, exec, atomic, identifier, tail, timeString, systemMetrics } from './core.mjs';
import { lua, staticLuaTable } from './lua.mjs';
import { Telemetry } from './telemetry.mjs';
import { MapRenderer } from './map-renderer.mjs';
import { readGameLog } from './game-logs.mjs';
import { WorldMetrics } from './world-metrics.mjs';
import { GameUpdateProgress, gameUpdateOutcome, runSteamUpdate } from './game-update.mjs';
import { GameVersionCheck, installedGameBuild } from './game-version.mjs';
import { readWhitelist, reservedClusterSource } from './reserved-slots.mjs';

export class Runtime {
  constructor(store) { this.store = store; this.config = store.config; this.telemetry = new Telemetry(this); this.consoleQueues=new Map();this.mapRenderer=new MapRenderer(this.config);this.worldMetrics=new WorldMetrics();this.gameVersions=new GameVersionCheck();this.gameUpdateController=null; }
  cancelGameUpdate() { if(!this.gameUpdateController)return false; this.gameUpdateController.abort(); return true; }
  session(room, shard) { return `Feather_${identifier(room)}_${identifier(shard)}`; }
  async sessions() {
    if (process.platform !== 'linux') return new Set();
    try { const { stdout } = await exec('screen', ['-ls']); return new Set([...stdout.matchAll(/\d+\.(Feather_[A-Za-z0-9_-]+)\s/g)].map(match => match[1])); }
    catch (error) { if (error.code === 1 && /No Sockets|No screens/i.test(error.stdout || '')) return new Set(); throw error; }
  }
  async status(id) {
    let room; try { room = this.store.getRoom(id); } catch (error) { if (error.status === 404) return []; throw error; }
    const sessions = await this.sessions();
    return room.worlds.map(world => ({ ...world, levelData:undefined, running:sessions.has(this.session(id, world.directory)), worldID:world.directory }));
  }
  async worldStatus(id) {
    return {worlds:this.worldMetrics.sample(id, await this.status(id), this.config.game), operationPending:this.store.locks.has(String(id))};
  }
  selectedWorlds(room, onlyWorlds) {
    if (onlyWorlds === null) return room.worlds;
    demand(Array.isArray(onlyWorlds) && onlyWorlds.length > 0 && new Set(onlyWorlds).size === onlyWorlds.length && onlyWorlds.every(directory => room.worlds.some(world => world.directory === directory)), '请选择有效的世界');
    return room.worlds.filter(world => onlyWorlds.includes(world.directory));
  }
  worldDay(id, world) {
    const base = inside(this.store.cluster(id), `${world.directory}/save/session`);
    if (!fs.existsSync(base)) return null;
    const sessions = fs.readdirSync(base, { withFileTypes:true }).filter(entry => entry.isDirectory() && /^[A-Fa-f0-9]{8,32}$/.test(entry.name));
    sessions.sort((a,b) => fs.statSync(inside(base,b.name)).mtimeMs - fs.statSync(inside(base,a.name)).mtimeMs);
    const latest = sessions[0]; if (!latest) return null;
    const files = fs.readdirSync(inside(base, latest.name)).filter(name => /^\d{1,16}\.meta$/.test(name));
    files.sort((a,b) => Number(b.split('.')[0]) - Number(a.split('.')[0]));
    for (const file of files) {
      const text = fs.readFileSync(inside(inside(base, latest.name), file), 'utf8').slice(0, 1048576);
      const match = text.match(/\bcycles\s*=\s*(\d+)/);
      if (match) return Number(match[1]) + 1;
    }
    return null;
  }
  async mapPreview(id, worldID, options = {}) {
    const worlds=await this.status(id),world=worlds.find(item=>item.directory===worldID);
    demand(world,'世界不存在',404);
    // Use saved terrain and available telemetry only. Rendering a map must
    // never wait for a game console query, even during startup or shutdown.
    const data=await this.telemetry.read(id,world,true);
    const room=this.store.getRoom(id);
    let mods=room.mods.filter(mod=>mod.enabled);
    // Read shard options, then prefer the latest snapshot's active mod list.
    const overrides=inside(this.store.cluster(id),`${world.directory}/modoverrides.lua`);
    if(fs.existsSync(overrides)) {
      try {
        const applied=staticLuaTable(fs.readFileSync(overrides,'utf8'));
        mods=Object.entries(applied).filter(([key,value])=>/^workshop-\d{6,20}$/.test(key)&&value?.enabled===true).map(([key,value])=>({id:key.slice(9),config:value.configuration_options||{}}));
      } catch { /* Imported dynamic overrides must not prevent reading a saved map. */ }
    }
    if(Array.isArray(data.savedMods))mods=data.savedMods.map(modID=>({id:modID,config:mods.find(mod=>String(mod.id)===modID)?.config||{}}));
    const cached=this.telemetry.cache.get(`${id}:${world.directory}:false`);
    const state=world.running&&cached&&Date.now()-cached.time<15000?cached.value:null;
    const renderData={...data,markers:state?.points||data.markers,mods,liveMapAssets:state?.mapAssets};
    const rendered=await this.mapRenderer.render(renderData, options);
    const day=Number.isInteger(state?.cycles)?state.cycles+1:this.worldDay(id,world);
    return {worldID:world.directory,world:world.type==='caves'?'洞穴':'森林',worlds,day,width:data.width,height:data.height,creatures:state?.creatures||data.creatures||{},creaturesSource:state?'live':'save',savedAt:data.savedAt,collectedAt:data.collectedAt,...rendered};
  }
  binary(room) {
    const bit64 = room.automation.startType === '64-bit';
    return inside(this.config.game, `${bit64 ? 'bin64' : 'bin'}/${bit64 ? 'dontstarve_dedicated_server_nullrenderer_x64' : 'dontstarve_dedicated_server_nullrenderer'}`);
  }
  async start(id, onlyWorlds = null) {
    const room = this.store.getRoom(id), selected = this.selectedWorlds(room, onlyWorlds);
    if(this.applyModUpdates)await this.applyModUpdates();
    demand(!this.store.sharedBusy,'游戏或共享模组正在更新，请稍后启动',409);
    demand(process.platform === 'linux', '启动游戏需要 Linux 部署环境', 503);
    const binary = this.binary(room);
    for(const mod of room.mods.filter(mod=>mod.enabled))demand(fs.existsSync(inside(this.config.game,'mods/workshop-'+mod.id+'/modinfo.lua')),'模组 '+mod.name+' 尚未安装，请先下载',409);
    demand(fs.existsSync(binary), '请先安装游戏服务端', 409);
    const token = inside(this.store.cluster(id), 'cluster_token.txt');
    demand(fs.existsSync(token) && fs.readFileSync(token,'utf8').trim(), '缺少游戏令牌', 409);
    const cluster=inside(this.store.cluster(id),'cluster.ini'),slots=readWhitelist(this.store,id).length;
    demand(slots<=room.maxPlayers,'白名单人数超过房间玩家上限，请先调整名单',409);
    if(fs.existsSync(cluster)){const previous=fs.readFileSync(cluster,'utf8'),next=reservedClusterSource(previous,slots);if(next!==previous)atomic(cluster,next);}
    const running = await this.sessions(), started = [];
    try {
      for (const world of selected) {
        const session = this.session(id, world.directory); if (running.has(session)) continue;
        this.telemetry.invalidate(id,world.directory);
        const env = { ...process.env, HOME:this.config.data };
        await exec('screen', ['-dmS', session, binary, '-console', '-persistent_storage_root', this.config.data, '-conf_dir', 'clusters', '-cluster', `Feather_${id}`, '-shard', world.directory], {cwd:path.dirname(binary),env});
        started.push(session);
      }
    } catch (error) { for (const session of started) { try { await exec('screen',['-S',session,'-X','quit']); } catch {} } throw error; }
    this.store.event(id, '已发送 ' + selected.map(world=>world.directory).join('、') + ' 启动请求，请通过世界状态和日志确认就绪');
    return { requested:true, worlds:await this.status(id) };
  }
  async command(id, command, worlds = null) {
    demand(process.platform === 'linux', '游戏控制需要 Linux 部署环境', 503);
    const room = this.store.getRoom(id), sessions = await this.sessions();
    for (const world of room.worlds.filter(world => !worlds || worlds.includes(world.directory))) {
      const session = this.session(id, world.directory);
      demand(sessions.has(session), `世界 ${world.directory} 未运行`, 409);
      const previous=this.consoleQueues.get(session)||Promise.resolve();
      const pending=previous.catch(()=>{}).then(async()=>{
        const text=command+'\r';
        for(let offset=0;offset<text.length;offset+=350)await exec('screen',['-S',session,'-p','0','-X','stuff',text.slice(offset,offset+350)]);
      });
      this.consoleQueues.set(session,pending);
      try{await pending;}finally{if(this.consoleQueues.get(session)===pending)this.consoleQueues.delete(session);}
    }
  }
  async stop(id, onlyWorlds = null) {
    const selected = this.selectedWorlds(this.store.getRoom(id), onlyWorlds).map(world=>world.directory);
    const running = (await this.status(id)).filter(world => world.running && selected.includes(world.directory));
    if (!running.length) return { stopped:true };
    running.forEach(world=>this.telemetry.invalidate(id,world.directory));
    await this.command(id, 'c_shutdown(true)', running.map(world => world.directory));
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      if (!(await this.status(id)).some(world => world.running && selected.includes(world.directory))) { this.store.event(id,selected.join('、')+' 已停止'); return {stopped:true}; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error('游戏尚未安全退出；未强制终止进程，请检查日志');
  }
  async restart(id) { await this.stop(id); return this.start(id); }
  async rollback(id, days) {
    demand(Number.isInteger(days) && days >= 1 && days <= 20, '回档天数应为 1～20');
    const room = this.store.getRoom(id);
    demand((await this.status(id)).every(world => world.running), '请先启动所有世界再回档', 409);
    await this.command(id, `c_rollback(${days})`, [room.worlds[0].directory]);
    room.worlds.forEach(world=>this.telemetry.invalidate(id,world.directory));
    this.store.event(id, `已请求回档 ${days} 天`); return {requested:true};
  }
  async reset(id) {
    const room = this.store.getRoom(id);
    demand((await this.status(id)).every(world => world.running), '请先启动所有世界再重置', 409);
    await this.command(id, 'c_regenerateworld()', [room.worlds[0].directory]);
    room.worlds.forEach(world=>this.telemetry.invalidate(id,world.directory));
    this.store.event(id,'已请求重置全部世界'); return {requested:true};
  }
  logs(id, options = {}) {
    const room = this.store.getRoom(id), cluster = this.store.cluster(id), rows = [];
    const limit = Math.max(50, Math.min(5000, Number.isInteger(options.limit) ? options.limit : 500));
    const requestedWorld = typeof options.world === 'string' ? options.world.trim() : '';
    const requestedType = ['game', 'chat', 'system'].includes(options.type) ? options.type : '';
    const worlds = requestedWorld && requestedWorld !== 'all'
      ? room.worlds.filter(world => world.directory === requestedWorld)
      : room.worlds;
    for (const world of worlds) {
      for (const [type, file] of [['game', 'server_log.txt'], ['chat', 'server_chat_log.txt']]) {
        if (requestedType && requestedType !== type) continue;
        for (const row of readGameLog(inside(cluster, `${world.directory}/${file}`), type, {limit}))
          rows.push({type, world:world.directory, ...row});
      }
    }
    if (!requestedType || requestedType === 'system') {
      if (!requestedWorld || requestedWorld === 'all' || requestedWorld === '面板') {
        this.store.db.prepare('SELECT time,message FROM events WHERE room=? ORDER BY id DESC LIMIT ?').all(String(id), limit).reverse().forEach(row => rows.push({type:'system',world:'面板',...row}));
      }
    }
    return {rows,worlds:room.worlds.map(world=>({directory:world.directory}))};
  }
  async overview(id) {
    const room = this.store.getRoom(id), worlds = await this.status(id);
    const log = tail(inside(this.store.cluster(id), `${room.worlds[0].directory}/server_log.txt`));
    const days = [...log.matchAll(/\bcycles\s*[=:]\s*(\d+)/g)].at(-1);let day = this.worldDay(id, room.worlds[0]);
    const collected=await Promise.all(worlds.map(async world=>{
      if(!world.running)return {world:world.directory,stopped:true};
      try{return {world:world.directory,data:await this.telemetry.read(id,world)};}catch(error){return {world:world.directory,error:error.message};}
    }));
    const uniquePlayers=new Map();
    for(const entry of collected)for(const player of entry.data?.players||[]){
      const previous=uniquePlayers.get(player.userid);
      if(!previous||player.localPlayer||!previous.localPlayer)uniquePlayers.set(player.userid,{...player,world:player.localPlayer===false?'角色选择/世界迁移中':entry.world});
    }
    const playerList=[...uniquePlayers.values()];
    const creatureCounts={};
    for(const entry of collected)for(const [name,count] of Object.entries(entry.data?.creatures||{}))creatureCounts[name]=(creatureCounts[name]||0)+Number(count||0);
    const complete=collected.every(entry=>!entry.error),players=complete?playerList.length:null;
    const master=collected[0]?.data;if(Number.isInteger(master?.cycles))day=master.cycles+1;
    const host = this.config.publicHost;
    return {roomID:String(id),name:room.name,maxPlayers:room.maxPlayers,worlds,day:day ?? (days ? Number(days[1])+1 : null),
      players,playerList,creatures:creatureCounts,telemetry:{complete,errors:collected.filter(entry=>entry.error).map(({world,error})=>({world,error})),season:master?.season||null,phase:master?.phase||null,seasonDay:Number.isInteger(master?.seasonDay)?master.seasonDay+1:null},mods:room.mods,enabledMods:room.mods.filter(mod=>mod.enabled).length,resources:systemMetrics(),
      directCode:host ? `c_connect(${lua(host)}, ${room.worlds[0].port}${room.password ? ', ' + lua(room.password) : ''})` : null,
      platform:process.platform,serverTime:timeString(Date.now())};
  }
  async playerClients(id) {
    const worlds=(await this.status(id)).filter(world=>world.running);
    demand(worlds.length,'房间未运行，无法查询在线玩家',409);
    const clients=await Promise.all(worlds.map(async world=>({world:world.directory,players:await this.telemetry.clients(id,world)})));
    return {worlds:worlds.map(world=>world.directory),playerList:clients.flatMap(entry=>entry.players.map(player=>({...player,world:entry.world})))};
  }
  gameUpdateStatus() {
    const versionFile=inside(this.config.game,'version.txt');
    const version=fs.existsSync(versionFile)?fs.readFileSync(versionFile,'utf8').trim().slice(0,80):null;
    const row=this.store.db.prepare("SELECT id FROM tasks WHERE kind IN ('更新游戏','安装游戏') ORDER BY created DESC,rowid DESC LIMIT 1").get();
    const manifest=inside(this.config.game,'steamapps/appmanifest_343050.acf');
    const buildID=fs.existsSync(manifest)?installedGameBuild(fs.readFileSync(manifest,'utf8')):null;
    return {installed:['bin/dontstarve_dedicated_server_nullrenderer','bin64/dontstarve_dedicated_server_nullrenderer_x64'].some(file=>fs.existsSync(inside(this.config.game,file))),version,buildID,task:row?this.store.getTask(row.id):null};
  }
  async gameUpdateCheck() {
    const status=this.gameUpdateStatus();
    const update=await this.gameVersions.status(status.installed?status.buildID:null);
    // A check may overlap a game update; compare against the current manifest.
    const current=this.gameUpdateStatus();
    return {...current,update:current.buildID===status.buildID?update:await this.gameVersions.status(current.installed?current.buildID:null)};
  }
  async install(report = () => {}, options = {}) {
    demand(process.platform === 'linux', '安装游戏需要 Linux 环境', 503);
    const script = inside(this.config.steam,'steamcmd.sh');
    demand(fs.existsSync(script), '未找到 SteamCMD，请检查安装目录或重新运行部署安装脚本', 409);
    const logFile = inside(this.config.data,'installation.log');
    const validate=options.validate===true;
    const args=['+force_install_dir',this.config.game,'+login','anonymous','+app_update','343050',...(validate?['validate']:[]),'+quit'];
    const startedAt=Date.now(),parser=new GameUpdateProgress();let output='',outcome=null;
    const controller=new AbortController();this.gameUpdateController=controller;
    const labels={connecting:'正在连接 Steam，检查更新',downloading:'正在下载游戏文件',verifying:'正在校验游戏文件',installing:'正在写入游戏文件',checking:'正在检查游戏程序与运行依赖'};
    const emit=()=>{const detail=parser.snapshot();report(detail.progress,labels[detail.phase]||'正在更新游戏',{...detail,elapsedMs:Date.now()-startedAt,validate});};
    emit();
    try {
      const heartbeat=setInterval(emit,1000);let lastEmit=0,result;
      try {
        result=await runSteamUpdate(script,args,{env:{...process.env,HOME:this.config.data},signal:controller.signal,cwd:path.dirname(script),onData:chunk=>{
          const text=String(chunk);output=(output+text).slice(-16*1048576);parser.consume(text);
          if(Date.now()-lastEmit>=250){lastEmit=Date.now();emit();}
        }});
      } finally {clearInterval(heartbeat);parser.flush();emit();}
      atomic(logFile,output);
      outcome=gameUpdateOutcome(output);
      demand(result.code===0&&outcome,'SteamCMD 未确认更新成功，详情见 installation.log',502);
    } catch (error) { this.gameUpdateController=null;if(output)atomic(logFile,output); if(error.code==='ECANCELED')throw Error('SteamCMD 更新已终止'); if(error.code==='ETIMEDOUT')throw Error('SteamCMD 更新超时，详情见 installation.log'); throw Error('SteamCMD 安装或更新失败，详情见 installation.log'); }
    this.gameUpdateController=null;
    report(null,'正在检查游戏程序与运行依赖',{...parser.snapshot(),phase:'checking',elapsedMs:Date.now()-startedAt,validate});
    const valid = ['bin/dontstarve_dedicated_server_nullrenderer','bin64/dontstarve_dedicated_server_nullrenderer_x64'].some(file=>fs.existsSync(inside(this.config.game,file)));
    demand(valid,'SteamCMD 返回后仍未找到游戏程序',502);
    for (const [source,destination] of [['linux32/steamclient.so','bin/lib32/steamclient.so'],['linux64/steamclient.so','bin64/lib64/steamclient.so']]) {
      if (fs.existsSync(inside(this.config.steam,source))) { const target=inside(this.config.game,destination); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.copyFileSync(inside(this.config.steam,source),target); }
    }
    return {installed:true,upToDate:outcome.upToDate,version:this.gameUpdateStatus().version,phase:'completed',progress:100,elapsedMs:Date.now()-startedAt,validate,logs:parser.logs};
  }
}
