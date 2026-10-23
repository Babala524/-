import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { Players } from '../src/players.mjs';
import { Runtime } from '../src/runtime.mjs';
import { Telemetry } from '../src/telemetry.mjs';
import { createPanel } from '../src/server.mjs';

const userid='KU_test-player';
function fixture(world='Master'){
  const events=[],commands=[],invalidations=[];
  let calls=0;
  const runtime={
    playerClients:async()=>({worlds:['Master','Caves'],playerList:++calls===1?[{userid,world}]:[]}),
    command:async(...args)=>commands.push(args),
    telemetry:{invalidate:(...args)=>invalidations.push(args)}
  };
  return {players:new Players({event:(...args)=>events.push(args)},runtime),runtime,events,commands,invalidations};
}
for(const world of ['Master','Caves','角色选择/世界迁移中'])test(`kick confirms disconnection for ${world} and targets all active shards`,async()=>{
  const f=fixture(world),progress=[];
  const result=await f.players.kick('0',userid,(...args)=>progress.push(args));
  assert.deepEqual(f.commands,[['0','TheNet:Kick(UserToClientID("KU_test-player") or "KU_test-player")',['Master','Caves']]]);
  assert.deepEqual(result,{kicked:true,confirmed:true,userid});assert.equal(f.events.length,1);
  assert.match(f.events[0][1],/已确认移出/);assert.equal(f.invalidations.length,4);assert.match(progress[1][1],/正在确认/);
});
test('kick never reports success if the player stays online',async()=>{
  const f=fixture();f.runtime.playerClients=async()=>({worlds:['Master','Caves'],playerList:[{userid,world:'Caves'}]});
  await assert.rejects(()=>f.players.kick('0',userid),/玩家仍在线/);assert.equal(f.events.length,0);
});
test('invalid IDs, offline players and incomplete queries do not become successful kicks',async()=>{
  const f=fixture();await assert.rejects(()=>f.players.kick('0','KU_xxx";bad()'),/格式/);assert.equal(f.commands.length,0);
  f.runtime.playerClients=async()=>({worlds:['Master'],playerList:[]});await assert.rejects(()=>f.players.kick('0',userid),/不在线/);assert.equal(f.commands.length,0);
  f.runtime.playerClients=async()=>{throw Error('cave query failed');};await assert.rejects(()=>f.players.kick('0',userid),/cave query failed/);assert.equal(f.events.length,0);
});
test('a query failure or stopped world after a kick cannot confirm success',async()=>{
  for(const stopped of [false,true]){
    const f=fixture();let calls=0;
    f.runtime.playerClients=async()=>{if(++calls===1)return {worlds:['Master','Caves'],playerList:[{userid}]};if(stopped)return {worlds:['Master'],playerList:[]};throw Error('confirmation query failed');};
    await assert.rejects(()=>f.players.kick('0',userid),stopped?/无法确认/:/confirmation query failed/);assert.equal(f.events.length,0);
  }
});
test('fresh player collection queries every active world and propagates errors',async()=>{
  const queried=[];
  const runtime={status:async()=>[{directory:'Master',running:true},{directory:'Caves',running:true},{directory:'Stopped',running:false}],telemetry:{clients:async(id,world)=>{queried.push(world.directory);return [{userid}];}}};
  const result=await Runtime.prototype.playerClients.call(runtime,'0');assert.deepEqual(queried,['Master','Caves']);assert.equal(result.playerList.length,2);
  runtime.telemetry.clients=async()=>{throw Error('no fresh data');};await assert.rejects(()=>Runtime.prototype.playerClients.call(runtime,'0'),/no fresh data/);
  runtime.status=async()=>[];await assert.rejects(()=>Runtime.prototype.playerClients.call(runtime,'0'),/房间未运行/);
});
test('connection verification ignores cached and old responses, and does not require an in-world player entity',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feather-clients-'));
  try{
    fs.mkdirSync(path.join(directory,'Master'));const log=path.join(directory,'Master/server_log.txt');
    fs.writeFileSync(log,'[00:00:00]: FP_00000000000000000000\t{"players":[]}\n');
    const runtime={store:{cluster:()=>directory},command:async(id,command,worlds)=>{
      assert.deepEqual(worlds,['Master']);assert.match(command,/GetPlayerClientTable/);assert.doesNotMatch(command,/LookupPlayerInst|Ents/);
      const token=command.match(/print\("(FP_[a-f0-9]{20})"/)[1];
      fs.appendFileSync(log,`[00:00:01]: ${token}\t${JSON.stringify({players:[{userid}]})}\n`);
    }};
    const telemetry=new Telemetry(runtime);telemetry.cache.set('0:Master:false',{time:Date.now(),value:{players:[]}});
    assert.deepEqual(await telemetry.clients('0',{directory:'Master'}),[{userid}]);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('frontend waits for confirmed disconnection and shows no success for failed or unconfirmed tasks',async()=>{
  const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const source=html.slice(html.indexOf('const pendingPlayerKicks='),html.indexOf('\n',html.indexOf('function kickManagedPlayer(')));
  for(const mode of ['confirmed','unconfirmed','failed']){
    const successes=[],messages=[];let action,release,refreshes=0;
    const promise=new Promise((resolve,reject)=>release={resolve,reject});
    const context=vm.createContext({Set,Error,window:{featherPanelServices:{kickPlayer:()=>promise}},toast:message=>messages.push(message),confirmRoomAction:(title,text,run)=>{action=run;},refreshPlayerManagement:async()=>{refreshes++;},showActionSuccess:(...args)=>successes.push(args)});
    vm.runInContext(source+';kickManagedPlayer({userid:"KU_test-player",name:"Test"})',context);
    const running=action();assert.equal(successes.length,0);assert.equal(refreshes,0);
    if(mode==='failed')release.reject(Error('玩家仍在线'));else release.resolve(mode==='confirmed'?{kicked:true,confirmed:true}:{});
    await running;
    assert.equal(successes.length,mode==='confirmed'?1:0);assert.equal(refreshes,mode==='confirmed'?1:0);
    if(mode!=='confirmed')assert.match(messages.at(-1),/仍在线|尚未确认/);
  }
});
test('authenticated kick endpoint completes only after a fresh query confirms disconnection and records real failures',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feather-kick-http-'));
  const app=createPanel({data:directory,translationProvider:'off'});
  try{
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${app.server.address().port}/api`,headers={Authorization:'Bearer '+app.store.adminToken,'Content-Type':'application/json'};
    let calls=0,commands=0,release;
    const disconnected=new Promise(resolve=>release=resolve);
    app.runtime.playerClients=async()=>{if(++calls===1)return {worlds:['Master'],playerList:[{userid}]};await disconnected;return {worlds:['Master'],playerList:[]};};
    app.runtime.command=async()=>{commands++;};
    const response=await fetch(base+'/rooms/0/players/kick',{method:'POST',headers,body:JSON.stringify({userid})});assert.equal(response.status,202);
    const {data:{taskID}}=await response.json();
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(app.store.getTask(taskID).state,'running');assert.equal(commands,1);
    assert.match(app.store.getTask(taskID).result.message,/正在确认/);release();
    const completed=async id=>{for(let i=0;i<200;i++){const result=app.store.getTask(id);if(['succeeded','failed'].includes(result.state))return result;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Task timed out');};
    const result=await completed(taskID);assert.equal(result.state,'succeeded');assert.equal(result.result.confirmed,true);
    app.runtime.playerClients=async()=>({worlds:['Master'],playerList:[]});
    const offline=await (await fetch(base+'/rooms/0/players/kick',{method:'POST',headers,body:JSON.stringify({userid})})).json();
    const failed=await completed(offline.data.taskID);assert.equal(failed.state,'failed');assert.match(failed.error,/不在线/);assert.equal(commands,1);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('player overview persists offline rankings and coalesces concurrent telemetry requests',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feather-player-rank-'));
  const app=createPanel({data:directory,translationProvider:'off'});
  try{
    app.store.putRoom('0',{});let calls=0,release;
    const collected=new Promise(resolve=>release=resolve);
    app.runtime.overview=async()=>{calls++;await collected;return {playerList:[{userid,name:'真实玩家',prefab:'wilson',playerage:123}],telemetry:{complete:true}};};
    const first=app.players.overview('0'),second=app.players.overview('0');release();
    const [a,b]=await Promise.all([first,second]);assert.equal(calls,1);assert.deepEqual(a,b);
    assert.equal(a.ranking[0].playSeconds,0);assert.equal(a.online[0].playerDays,123);assert.equal(a.statistics.complete,true);
    app.runtime.overview=async()=>({playerList:[],telemetry:{complete:true}});
    const offline=await app.players.overview('0');assert.equal(offline.ranking[0].online,false);assert.equal(offline.online.length,0);
    app.runtime.overview=async()=>({playerList:[],telemetry:{complete:false}});
    const partial=await app.players.overview('0');assert.equal(partial.ranking[0].online,null);assert.equal(partial.statistics.complete,false);assert.equal(app.players.stats.previous.has('0'),false);
  }finally{app.close();fs.rmSync(directory,{recursive:true,force:true});}
});
