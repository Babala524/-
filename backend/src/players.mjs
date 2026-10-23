import fs from 'node:fs';
import { demand, inside, atomic } from './core.mjs';
import { lua } from './lua.mjs';
import { PlayerStats } from './player-stats.mjs';
import { readWhitelist, whitelistFile, reservedClusterSource } from './reserved-slots.mjs';

const userID = value => { const id = String(value || '').trim(); demand(/^KU_[A-Za-z0-9_-]{4,80}$/.test(id), '科雷 ID 格式不正确'); return id; };
const readList = file => fs.existsSync(file) ? [...new Set(fs.readFileSync(file,'utf8').split(/\r?\n/).map(value=>value.trim()).filter(Boolean))] : [];
const writeList = (file, values) => atomic(file, [...new Set(values)].join('\n') + ([...new Set(values)].length ? '\n' : ''));

export class Players {
  constructor(store, runtime) { this.store=store; this.runtime=runtime; this.stats=store.db?new PlayerStats(store.db):null; this.pending=new Map(); }
  files(id) { const cluster=this.store.cluster(id); return {admins:inside(cluster,'adminlist.txt'), blacklist:inside(cluster,'blocklist.txt'),whitelist:whitelistFile(this.store,id)}; }
  lists(id) { this.store.getRoom(id); const files=this.files(id); return {admins:readList(files.admins),blacklist:readList(files.blacklist),whitelist:readWhitelist(this.store,id)}; }
  async overview(id) {
    id=String(id);
    if(this.pending.has(id))return this.pending.get(id);
    const request=this.collect(id);this.pending.set(id,request);
    try{return await request;}finally{this.pending.delete(id);}
  }
  async collect(id) {
    let state;
    try{state=await this.runtime.overview(id);}catch(error){this.stats?.previous.delete(id);throw error;}
    this.stats?.observe(id,state);
    const lists=this.lists(id),complete=state.telemetry?.complete===true,ids=new Set((state.playerList||[]).map(p=>p.userid));
    const ranking=(this.stats?.ranking(id)||[]).map(p=>({...p,admin:lists.admins.includes(p.userid),blacklisted:lists.blacklist.includes(p.userid),whitelisted:lists.whitelist.includes(p.userid),online:complete?ids.has(p.userid):null}));
    const records=new Map(ranking.map(p=>[p.userid,p]));
    const online=(state.playerList||[]).map(player=>({...records.get(player.userid),...player,online:true,admin:lists.admins.includes(player.userid),blacklisted:lists.blacklist.includes(player.userid),whitelisted:lists.whitelist.includes(player.userid),playerDays:player.playerage??null}));
    const capacity=Number(this.store.getRoom(id).maxPlayers)||0;
    return {...lists,online,ranking,reservation:{capacity,reserved:lists.whitelist.length,publicSlots:Math.max(0,capacity-lists.whitelist.length)},statistics:{startedAt:this.stats?.started(id)||null,sampleSeconds:15,complete,totalPlayers:ranking.length,totalSeconds:ranking.reduce((n,p)=>n+p.playSeconds,0)}};
  }
  async tick() {
    for(const room of this.store.rooms())try{await this.overview(room.id);}catch(error){console.error('Player statistics:',error.message);}
  }
  set(id, kind, value, enabled) {
    this.store.getRoom(id); demand(kind==='admins'||kind==='blacklist','玩家名单类型不合法'); const idValue=userID(value), files=this.files(id), file=files[kind], values=readList(file);
    const next=enabled ? [...new Set([...values,idValue])] : values.filter(item=>item!==idValue); writeList(file,next); this.store.event(id,`${enabled?'已添加':'已移出'}玩家${kind==='admins'?'管理员':'黑名单'}：${idValue}`); return {saved:true,kind,values:next};
  }
  async setWhitelist(id,value,enabled) {
    const idValue=userID(value);demand(typeof enabled==='boolean','白名单操作不合法');
    return this.store.locked(id,async()=>{
      const room=this.store.getRoom(id),files=this.files(id),values=readWhitelist(this.store,id);
      const next=enabled?[...new Set([...values,idValue])]:values.filter(item=>item!==idValue);
      demand(next.length<=room.maxPlayers,'白名单人数不能超过房间玩家上限',409);
      demand(!enabled||!readList(files.blacklist).includes(idValue),'该玩家在黑名单中，请先移出黑名单',409);
      const cluster=inside(this.store.cluster(id),'cluster.ini');demand(fs.existsSync(cluster),'请先保存房间设置',409);
      if(JSON.stringify(next)===JSON.stringify(values))return {saved:true,kind:'whitelist',values:next,requiresRestart:(await this.runtime.status(id)).some(world=>world.running),unchanged:true};
      const before=fs.readFileSync(cluster),oldList=fs.existsSync(files.whitelist)?fs.readFileSync(files.whitelist):null;
      const running=(await this.runtime.status(id)).some(world=>world.running);
      try{writeList(files.whitelist,next);atomic(cluster,reservedClusterSource(before.toString('utf8'),next.length));}
      catch(error){atomic(cluster,before);if(oldList===null)fs.rmSync(files.whitelist,{force:true});else atomic(files.whitelist,oldList);throw error;}
      this.store.event(id,`${enabled?'已加入':'已移出'}白名单：${idValue}，预留 ${next.length} 个名额${running?'，重启后生效':''}`);
      return {saved:true,kind:'whitelist',values:next,requiresRestart:running,reservation:{capacity:room.maxPlayers,reserved:next.length,publicSlots:room.maxPlayers-next.length}};
    });
  }
  async kick(id, value, report=()=>{}) {
    const idValue=userID(value);
    report(10,'正在核实玩家在线状态');
    const state=await this.runtime.playerClients(id);
    demand(state.playerList.some(player=>player.userid===idValue),'玩家当前不在线',404);
    // TheNet:Kick accepts a Klei user ID. Send to all active shards so cave
    // players and clients migrating between shards are also disconnected.
    const target=lua(idValue);
    await this.runtime.command(id,`TheNet:Kick(UserToClientID(${target}) or ${target})`,state.worlds);
    for(const world of state.worlds)this.runtime.telemetry.invalidate(id,world);
    report(30,'移出命令已发送，正在确认玩家离线');
    for(let attempt=0;attempt<12;attempt++){
      await new Promise(resolve=>setTimeout(resolve,500));
      const current=await this.runtime.playerClients(id);
      demand(state.worlds.every(world=>current.worlds.includes(world)),'世界运行状态发生变化，无法确认移出结果',409);
      if(!current.playerList.some(player=>player.userid===idValue)){
        for(const world of current.worlds)this.runtime.telemetry.invalidate(id,world);
        this.store.event(id,`已确认移出在线玩家：${idValue}`);
        return {kicked:true,confirmed:true,userid:idValue};
      }
      report(35+attempt*5,'正在等待游戏确认玩家离线');
    }
    demand(false,'游戏未确认移出：玩家仍在线，请重试或查看游戏日志',504);
  }
}
