import zlib from 'node:zlib';
import { tail, inside, Fault } from './core.mjs';

const regions=['ap-southeast-1','ap-east-1','eu-central-1','us-east-1'];
export class Lobby {
  constructor(store){this.store=store;this.fetch=fetch;this.cache=new Map();this.pending=new Map();}
  async listing(region) {
    const cached=this.cache.get(region);if(cached&&Date.now()-cached.time<20000)return cached;
    if(this.pending.has(region))return this.pending.get(region);
    const pending=(async()=>{
      const response=await this.fetch('https://lobby-v2-cdn.klei.com/'+region+'-Steam.json.gz',{signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('大厅列表 HTTP '+response.status);
      let buffer=Buffer.from(await response.arrayBuffer());
      if(buffer.length>24*1048576)throw Error('大厅列表体积异常');
      if(buffer[0]===31&&buffer[1]===139)buffer=zlib.gunzipSync(buffer,{maxOutputLength:48*1048576});
      const data=JSON.parse(buffer);if(!Array.isArray(data.GET))throw Error('大厅列表格式异常');
      const result={time:Date.now(),rows:data.GET};this.cache.set(region,result);return result;
    })().finally(()=>this.pending.delete(region));this.pending.set(region,pending);return pending;
  }
  async check(id) {
    const room=this.store.getRoom(id),master=room.worlds[0],log=tail(inside(this.store.cluster(id),master.directory+'/server_log.txt'));
    const primary=[...log.matchAll(/Server registered(?: via geo DNS)? in ([a-z]{2}-[a-z]+-\d)/g)].at(-1)?.[1];
    const order=[...new Set([primary,...regions].filter(value=>regions.includes(value)))],checked=[],errors=[],candidates=[];
    const host=this.store.config.publicHost;
    const inspect=async region=>{
      try{
        const list=await this.listing(region);checked.push(region);
        const rows=list.rows.filter(row=>row.name===room.name&&Number(row.maxconnections)===room.maxPlayers&&Number(row.port)===master.port);
        for(const row of rows){
          const exact=!!host&&row.__addr===host;
          candidates.push({region,address:row.__addr,port:Number(row.port),name:row.name,players:Number(row.connected)||0,maxPlayers:Number(row.maxconnections),match:exact?'address-port-name':'name-port-capacity',lobbyID:row.__rowId,session:row.session});
        }
      }catch(error){errors.push({region,error:error.message});}
    };
    if(primary)await inspect(primary);
    if(!candidates.some(row=>row.match==='address-port-name'))await Promise.all(order.filter(region=>!checked.includes(region)&&!errors.some(error=>error.region===region)).map(inspect));
    if(!checked.length)throw new Fault(502,'科雷大厅列表暂时无法访问，请稍后重试');
    // Klei may publish the server through a geo-DNS address rather than the
    // machine's configured public IP. Prefer an exact address match, but when
    // the name/port/player-capacity tuple is unique, accept that single
    // candidate as the current room. Keeping the unique check prevents a
    // duplicate room name from being reported as this server.
    const exactMatches=candidates.filter(row=>row.match==='address-port-name');
    const matches=exactMatches.length ? exactMatches : candidates.length===1 ? candidates : [];
    return {listed:matches.length>0,roomName:room.name,matches,candidates:matches.length?[]:candidates,complete:errors.length===0,checkedRegions:checked,errors,checkedAt:new Date().toISOString(),message:matches.length?'已在科雷服务器列表找到当前房间':errors.length?'部分地区查询失败，暂未找到当前房间':'科雷服务器列表暂未找到当前房间；刚启动可能尚未同步'};
  }
}

