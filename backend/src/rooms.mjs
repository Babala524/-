import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { demand, Fault, inside, atomic, identifier, modID } from './core.mjs';
import { levelData, lua, presets } from './lua.mjs';
import { defaultClusterToken } from './upstream-default.mjs';
import { readWhitelist } from './reserved-slots.mjs';
import { normaliseAnnouncements } from './announcements.mjs';

const modes = new Set(['endless','survival','relaxed','wilderness','lightsOut','lavaarena','quagmire']);
const iniText = (value, maximum, label) => { demand(typeof value === 'string' && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value), `${label}格式不合法`); return value; };
export class Rooms {
  constructor(store, runtime) { this.store = store; this.runtime = runtime; }
  public(config) { const { _ports, _clusterKey, ...data } = config; return data; }
  modOverrides(mods) { return 'return '+lua(Object.fromEntries(mods.filter(mod=>mod.enabled).map(mod=>['workshop-'+mod.id,{enabled:true,configuration_options:mod.config}])) )+'\n'; }
  validateInstalled(mods) {
    for(const mod of mods.filter(mod=>mod.enabled))demand(fs.existsSync(inside(this.store.config.game,'mods/workshop-'+mod.id+'/modinfo.lua')),'模组 '+mod.name+' 尚未安装，请先下载再应用',409);
  }
  // Caller holds the room lock. Mod-only saves do not change world or room settings.
  saveMods(id,mods) {
    const previous=this.store.getRoom(id),data={...previous,mods:this.normalise(id,{...previous,mods}).mods};
    this.validateInstalled(data.mods);
    const files=data.worlds.map(world=>inside(this.store.cluster(id),world.directory+'/modoverrides.lua'));
    const before=files.map(file=>[file,fs.existsSync(file)?fs.readFileSync(file):null]);
    try{for(const file of files)atomic(file,this.modOverrides(data.mods));this.store.putRoom(id,data);}
    catch(error){for(const [file,old]of before)if(old===null)fs.rmSync(file,{force:true});else atomic(file,old);throw error;}
    this.store.event(id,'房间模组已保存到所有世界，重启后加载');
    return {saved:true,mods:data.mods};
  }
  async control(id,action,mods) {
    return this.store.locked(id,async()=>{
      demand(!this.store.sharedBusy,'游戏文件正在更新，请稍后操作',409);
      const current=this.store.getRoom(id),next=mods===undefined?current.mods:this.normalise(id,{...current,mods}).mods;
      this.validateInstalled(next);
      const signature=value=>JSON.stringify(value.filter(mod=>mod.enabled).map(mod=>[mod.id,mod.config]).sort((a,b)=>a[0].localeCompare(b[0])));
      const changed=signature(current.mods)!==signature(next),running=(await this.runtime.status(id)).some(world=>world.running);
      if(running&&(action==='restart'||changed))await this.runtime.stop(id);
      if(mods!==undefined)this.saveMods(id,next);
      const result=await this.runtime.start(id);
      return {...result,modsSaved:mods!==undefined,restarted:running&&(action==='restart'||changed),enabledMods:next.filter(mod=>mod.enabled).length};
    });
  }
  worldTarget(id, worldID) {
    const world = this.store.getRoom(id).worlds.find(world=>world.directory === worldID);
    demand(typeof worldID === 'string' && world, '世界不存在', 404); return world;
  }
  async controlWorld(id, worldID, action) {
    demand(['start','stop'].includes(action), '未知世界操作');
    this.worldTarget(id, worldID);
    return this.store.locked(id, async()=>{
      this.worldTarget(id, worldID);
      if (action === 'start') {
        this.validateInstalled(this.store.getRoom(id).mods);
        await this.runtime.start(id, [worldID]);
        // A screen invocation can return before its process is registered.
        await new Promise(resolve=>setTimeout(resolve, 500));
        const world = (await this.runtime.status(id)).find(world=>world.directory === worldID);
        demand(world?.running, '世界未能保持运行，请检查游戏日志', 502);
        return {requested:true, worldID, running:true};
      }
      const result = await this.runtime.stop(id, [worldID]);
      demand(result.stopped, '世界尚未确认停止', 502);
      return {stopped:true, worldID, running:false};
    });
  }
  normalise(id, input) {
    demand(input && typeof input === 'object' && !Array.isArray(input), '房间配置必须是对象');
    const name = iniText(input.name, 40, '房间名字'); demand(name.trim(), '房间名字不能为空');
    const password = iniText(input.password ?? '', 64, '密码');
    const description=iniText(input.description??'',256,'房间介绍公告');
    const announcement=normaliseAnnouncements(input.announcement);
    demand(Number.isInteger(input.maxPlayers) && input.maxPlayers >= 1 && input.maxPlayers <= 64, '玩家上限应为 1～64');
    demand(modes.has(input.mode), '游戏模式不合法');
    for (const flag of ['pvp','pause','vote']) demand(typeof input[flag] === 'boolean', `${flag} 必须为布尔值`);
    demand(Number.isInteger(input.worldCount) && input.worldCount >= 1 && input.worldCount <= 8, '世界层数应为 1～8');
    demand(Array.isArray(input.worlds) && input.worlds.length >= input.worldCount, '世界配置不完整');
    const worlds = input.worlds.slice(0, input.worldCount).map((world, index) => {
      demand(world && ['forest', 'caves'].includes(world.type), '世界类型不合法');
      const directory = world.directory || (index ? `Shard${index + 1}` : 'Master');
      demand(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(directory), '世界目录不合法');
      demand(Number.isInteger(world.port) && world.port >= 1024 && world.port <= 65535, '直连端口不合法');
      const source = world.levelData || presets[input.mode]?.[world.type === 'caves' ? 'caves' : 'master'] || presets.endless.master;
      try { levelData(source); } catch (error) { throw new Fault(400, `第 ${index + 1} 层世界：${error.message}`); }
      return { directory, type: world.type, port: world.port, levelData: source };
    });
    demand(new Set(worlds.map(world => world.directory)).size === worlds.length, '世界目录不能重复');
    demand(new Set(worlds.map(world => world.port)).size === worlds.length, '世界直连端口不能重复');
    demand(!worlds.some(world=>world.port===this.store.config.port),'直连端口与面板端口冲突');
    const automation = input.automation;
    demand(automation && typeof automation.autoBackup === 'boolean' && /^([01]\d|2[0-3]):[0-5]\d$/.test(automation.backupTime) && ['32-bit','64-bit'].includes(automation.startType), '自动化设置不合法');
    const autoRestart=automation.autoRestart??false,restartTime=automation.restartTime??'05:00';
    demand(typeof autoRestart==='boolean'&&typeof restartTime==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(restartTime),'定时重启设置不合法');
    demand(readWhitelist(this.store,id).length<=input.maxPlayers,'玩家上限不能小于白名单人数，请先移出多余的白名单玩家',409);
    demand(Array.isArray(input.mods) && input.mods.length <= 300, '模组配置数量不合法');
    const mods = input.mods.map(mod => {
      demand(mod && typeof mod.enabled === 'boolean', '模组启用设置不合法');
      const id = modID(mod.id), config = mod.config ?? {};
      demand(config && typeof config === 'object' && !Array.isArray(config) && JSON.stringify(config).length <= 65536, '模组参数不合法');
      lua(config);
      return { id, name: String(mod.name || id).slice(0,180), enabled: mod.enabled, config };
    });
    demand(new Set(mods.map(mod => mod.id)).size === mods.length, '模组 ID 不能重复');
    const others = this.store.rooms().filter(room => room.id !== id);
    const occupied = new Set(others.flatMap(room => [...room.worlds.map(world => world.port), ...(room._ports || [])]));
    worlds.forEach(world => demand(!occupied.has(world.port), `端口 ${world.port} 已被其他房间使用`, 409));
    worlds.forEach(world => occupied.add(world.port)); occupied.add(this.store.config.port);
    let old; try { old = this.store.getRoom(id); } catch (error) { if (error.status !== 404) throw error; }
    const allocate = (preferred, start) => {
      let port=Number.isInteger(preferred)&&preferred>=1024&&preferred<=65535&&!occupied.has(preferred)?preferred:start;
      while(occupied.has(port))port++;
      demand(port<=65535,'没有可分配的端口',409);occupied.add(port);return port;
    };
    // Match DMP's separate shard / Steam query / authentication ranges.
    // Existing room ports stay stable when only visible settings are edited.
    const _ports=[allocate(old?._ports?.[0],21001)];
    worlds.forEach(world=>{
      const oldIndex=old?.worlds?.findIndex(item=>item.directory===world.directory)??-1;
      _ports.push(allocate(oldIndex<0?null:old._ports?.[1+oldIndex*2],31001),allocate(oldIndex<0?null:old._ports?.[2+oldIndex*2],41001));
    });
    return { schemaVersion:3, name, password, description, announcement, maxPlayers:input.maxPlayers, mode:input.mode, pvp:input.pvp, pause:input.pause, vote:input.vote,
      worldCount:worlds.length, worlds, mods, automation:{backupTime:automation.backupTime,autoBackup:automation.autoBackup,startType:automation.startType,autoRestart,restartTime},
      _ports, _clusterKey:old?._clusterKey || crypto.randomBytes(24).toString('hex') };
  }
  async save(id, input) {
    id = identifier(id);
    return this.store.locked(id, async () => {
      const data = this.normalise(id, input), cluster = this.store.cluster(id);
      const running = (await this.runtime.status(id)).some(world=>world.running);
      const gameMode = data.mode === 'lightsOut' ? 'survival' : data.mode;
      const files = new Map([['cluster.ini', `[GAMEPLAY]\ngame_mode = ${gameMode}\nmax_players = ${data.maxPlayers}\npvp = ${data.pvp}\npause_when_empty = ${data.pause}\nvote_enabled = ${data.vote}\nvote_kick_enabled = ${data.vote}\n\n[NETWORK]\ncluster_name = ${data.name}\ncluster_password = ${data.password}\ncluster_language = zh\nlan_only_cluster = false\noffline_cluster = false\n\n[MISC]\nconsole_enabled = true\nmax_snapshots = 20\n\n[SHARD]\nshard_enabled = true\nbind_ip = 127.0.0.1\nmaster_ip = 127.0.0.1\nmaster_port = ${data._ports[0]}\ncluster_key = ${data._clusterKey}\n`]]);
      const tokenPath = inside(cluster, 'cluster_token.txt');
      const token = this.store.config.clusterToken || (fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : defaultClusterToken());
      demand(token && !/[\r\n]/.test(token), '游戏令牌不可用', 409); files.set('cluster_token.txt', token + '\n');
      data.worlds.forEach((world,index) => {
        files.set(`${world.directory}/server.ini`, `[NETWORK]\nserver_port = ${world.port}\n\n[SHARD]\nid = ${index + 1}\nis_master = ${index === 0}\nname = ${world.directory}\n\n[STEAM]\nmaster_server_port = ${data._ports[1+index*2]}\nauthentication_port = ${data._ports[2+index*2]}\n\n[ACCOUNT]\nencode_user_path = true\n`);
        files.set(`${world.directory}/leveldataoverride.lua`, world.levelData);
        files.set(`${world.directory}/modoverrides.lua`, this.modOverrides(data.mods));
      });
      const before = new Map();
      files.set('cluster.ini',files.get('cluster.ini').replace('cluster_name = ',`cluster_description = ${data.description}\ncluster_name = `));
      files.set('cluster.ini',files.get('cluster.ini').replace('[NETWORK]\n',`[NETWORK]\nwhitelist_slots = ${readWhitelist(this.store,id).length}\n`));
      try {
        for (const [relative, content] of files) { const file = inside(cluster, relative); before.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null); atomic(file, content); }
        this.store.putRoom(id, data);
      } catch (error) { for (const [file, old] of before) { if (old === null) fs.rmSync(file, {force:true}); else atomic(file, old); } throw error; }
      this.store.event(id, running ? '房间配置已保存并写入游戏目录，重启后生效' : '房间配置已保存并写入游戏目录');
      return { saved:true, requiresRestart:running, config:this.public(data) };
    });
  }
}
