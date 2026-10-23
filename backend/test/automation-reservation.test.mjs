import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPanel} from '../src/server.mjs';
import {presets} from '../src/lua.mjs';
import {reservedClusterSource} from '../src/reserved-slots.mjs';

const draft=()=>({name:'定时重启测试',password:'',maxPlayers:6,mode:'endless',pvp:false,pause:true,vote:true,worldCount:2,worlds:[{directory:'Master',type:'forest',port:11001,levelData:presets.endless.master},{directory:'Caves',type:'caves',port:11002,levelData:presets.endless.caves}],mods:[],automation:{autoBackup:false,backupTime:'06:00',startType:'64-bit',autoRestart:true,restartTime:'05:00'}});
async function fixture(){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-automation-'));
  const app=createPanel({data,game:path.join(data,'dst'),timezone:'Asia/Shanghai',translationProvider:'off',clusterToken:'test'});
  app.stopTimers();app.runtime.sessions=async()=>new Set();await app.rooms.save('0',draft());
  return {...app,data,cleanup:async()=>{if(app.server.listening)await new Promise(r=>app.server.close(r));app.close();fs.rmSync(data,{recursive:true,force:true});}};
}
async function settled(app){
  for(let i=0;i<200;i++){
    const rows=app.store.db.prepare('SELECT id,state FROM tasks').all();
    if(rows.every(t=>['failed','succeeded'].includes(t.state)))return rows.map(t=>app.store.getTask(t.id));
    await new Promise(r=>setTimeout(r,5));
  }
  throw Error('Tasks did not finish');
}
const at=new Date('2026-10-21T21:00:00Z'); // 05:00 in the configured server time zone.

test('daily restart runs once per server day, persists deduplication and preserves stopped shards',async()=>{
  const app=await fixture(),stops=[],starts=[];
  try{
    app.runtime.status=async()=>[{directory:'Master',running:true},{directory:'Caves',running:false}];
    app.runtime.stop=async(id,worlds)=>{stops.push(worlds);return {stopped:true};};
    app.runtime.start=async(id,worlds)=>{starts.push(worlds);return {requested:true};};
    await Promise.all([app.saves.tick(at),app.saves.tick(at)]);const tasks=await settled(app);
    assert.equal(tasks.length,1);assert.equal(tasks[0].state,'succeeded');assert.deepEqual(stops,[['Master']]);assert.deepEqual(starts,[['Master']]);
    await app.saves.tick(at);await settled(app);assert.equal(starts.length,1);
    assert.equal(app.store.db.prepare('SELECT day FROM schedule_runs WHERE room=? AND kind=?').get('0','restart').day,'2026-10-22');
    await app.saves.tick(new Date('2026-10-22T21:00:00Z'));await settled(app);assert.equal(starts.length,2);
  }finally{await app.cleanup();}
});
test('disabled schedules, wrong minute, room lock and shared game updates do not restart games',async()=>{
  const app=await fixture();try{
    await app.saves.tick(new Date('2026-10-21T20:59:00Z'));
    app.store.locks.add('0');await app.saves.tick(at);app.store.locks.delete('0');
    app.store.sharedBusy=true;await app.saves.tick(at);app.store.sharedBusy=false;
    const room=app.store.getRoom('0');room.automation.autoRestart=false;app.store.putRoom('0',room);await app.saves.tick(at);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM schedule_runs').get().n,0);
  }finally{await app.cleanup();}
});
test('scheduled restart skips stopped rooms and records a stop failure without attempting a start',async()=>{
  const app=await fixture();try{
    let starts=0;app.runtime.start=async()=>{starts++;};
    await app.saves.tick(at);assert.equal((await settled(app))[0].result.skipped,true);assert.equal(starts,0);
    app.runtime.status=async()=>[{directory:'Master',running:true}];app.runtime.stop=async()=>({stopped:false});
    await app.saves.tick(new Date('2026-10-22T21:00:00Z'));const failed=(await settled(app)).find(t=>t.state==='failed');assert.match(failed.error,/未确认关闭/);assert.equal(starts,0);
  }finally{await app.cleanup();}
});
test('same-minute backup and restart are merged into a single locked operation',async()=>{
  const app=await fixture();try{
    const room=app.store.getRoom('0');room.automation.autoBackup=true;room.automation.backupTime='05:00';app.store.putRoom('0',room);
    let backups=0,restarts=0;app.saves.backup=async()=>{assert.ok(app.store.locks.has('0'));backups++;return {backedUp:true};};app.saves.scheduledRestart=async()=>{restarts++;};
    await app.saves.tick(at);await app.saves.tick(at);const tasks=await settled(app);assert.equal(tasks.length,1);assert.equal(backups,1);assert.equal(restarts,0);assert.equal(tasks[0].result.restartIncluded,true);
  }finally{await app.cleanup();}
});
test('legacy automation defaults remain compatible and malformed restart fields are rejected',async()=>{
  const app=await fixture();try{
    const room=draft();delete room.automation.autoRestart;delete room.automation.restartTime;
    const saved=(await app.rooms.save('0',room)).config;assert.equal(saved.automation.autoRestart,false);assert.equal(saved.automation.restartTime,'05:00');
    for(const automation of [{autoRestart:'true'},{restartTime:'25:01'},{restartTime:'5:00'}])await assert.rejects(()=>app.rooms.save('0',{...draft(),automation:{...draft().automation,...automation}}),/定时重启/);
  }finally{await app.cleanup();}
});
test('three whitelisted IDs reserve three of six slots; duplicate, removal, restart and room saves stay consistent',async()=>{
  const app=await fixture();try{
    for(const userid of ['KU_friend01','KU_friend02','KU_friend03'])assert.equal((await app.players.setWhitelist('0',userid,true)).requiresRestart,false);
    const cluster=path.join(app.store.cluster('0'),'cluster.ini'),file=path.join(app.store.cluster('0'),'whitelist.txt');
    assert.match(fs.readFileSync(cluster,'utf8'),/\[NETWORK\]\nwhitelist_slots = 3\n/);assert.equal(fs.readFileSync(file,'utf8').trim().split('\n').length,3);
    app.runtime.overview=async()=>({playerList:[{userid:'KU_friend01',name:'朋友'}],telemetry:{complete:true}});
    const view=await app.players.overview('0');assert.deepEqual(view.reservation,{capacity:6,reserved:3,publicSlots:3});assert.equal(view.online[0].whitelisted,true);
    assert.equal((await app.players.setWhitelist('0','KU_friend03',true)).unchanged,true);
    await app.rooms.save('0',{...draft(),name:'修改房间名字'});assert.match(fs.readFileSync(cluster,'utf8'),/whitelist_slots = 3/);
    app.runtime.status=async()=>[{directory:'Master',running:true}];const removed=await app.players.setWhitelist('0','KU_friend02',false);assert.equal(removed.requiresRestart,true);assert.equal(removed.reservation.publicSlots,4);
    assert.match(fs.readFileSync(cluster,'utf8'),/whitelist_slots = 2/);assert.equal(app.players.lists('0').whitelist.includes('KU_friend02'),false);
  }finally{await app.cleanup();}
});
test('whitelist rejects overflow, blacklisted or unsafe IDs and shrinking below reservations without changing files',async()=>{
  const app=await fixture();try{
    await app.rooms.save('0',{...draft(),maxPlayers:1});await app.players.setWhitelist('0','KU_friend01',true);
    const file=path.join(app.store.cluster('0'),'whitelist.txt'),before=fs.readFileSync(file,'utf8');
    await assert.rejects(()=>app.players.setWhitelist('0','KU_friend02',true),/不能超过/);
    await assert.rejects(()=>app.players.setWhitelist('0','KU_bad\nentry',true),/格式/);
    await app.rooms.save('0',draft());app.players.set('0','blacklist','KU_banned01',true);
    await assert.rejects(()=>app.players.setWhitelist('0','KU_banned01',true),/黑名单/);
    await app.players.setWhitelist('0','KU_friend02',true);
    await assert.rejects(()=>app.rooms.save('0',{...draft(),maxPlayers:1}),/不能小于白名单/);
    assert.deepEqual(app.players.lists('0').whitelist,['KU_friend01','KU_friend02']);assert.match(before,/KU_friend01/);
  }finally{await app.cleanup();}
});
test('INI reservation editing preserves other sections and removes duplicate NETWORK keys',()=>{
  const updated=reservedClusterSource('[NETWORK]\r\nwhitelist_slots=1\r\ncluster_name=hello\r\nwhitelist_slots = 9\r\n[OTHER]\r\nwhitelist_slots=7\r\n',3);
  assert.equal((updated.match(/whitelist_slots/g)||[]).length,2);assert.match(updated,/cluster_name=hello/);assert.match(updated,/\[OTHER\]\nwhitelist_slots=7/);assert.match(updated,/\[NETWORK\]\nwhitelist_slots = 3/);
});
test('whitelist endpoint is authenticated, validates booleans and persists the native permission list',async()=>{
  const app=await fixture();try{
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}/api/rooms/0/players/list`;
    const input={kind:'whitelist',userid:'KU_friend01',enabled:true},headers={Authorization:'Bearer '+app.store.adminToken,'Content-Type':'application/json'};
    assert.equal((await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,401);
    assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify({...input,enabled:'false'})})).status,400);
    const response=await fetch(base,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,200);assert.equal((await response.json()).data.reservation.publicSlots,5);
    assert.deepEqual(app.players.lists('0').whitelist,['KU_friend01']);
  }finally{await app.cleanup();}
});
