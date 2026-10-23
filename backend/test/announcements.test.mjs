import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPanel} from '../src/server.mjs';
import {presets} from '../src/lua.mjs';
import {lua} from '../src/lua.mjs';

const draft=()=>({name:'公告测试房间',password:'',description:'欢迎加入，友好交流',announcement:{enabled:true,message:'欢迎来到房间！\n请勿破坏建筑。',intervalMinutes:5},maxPlayers:6,mode:'endless',pvp:false,pause:true,vote:true,worldCount:2,worlds:[{directory:'Master',type:'forest',port:11001,levelData:presets.endless.master},{directory:'Caves',type:'caves',port:11002,levelData:presets.endless.caves}],mods:[],automation:{autoBackup:false,backupTime:'06:00',startType:'64-bit'}});
async function fixture(){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-announcement-'));
 const app=createPanel({data,game:path.join(data,'dst'),translationProvider:'off',clusterToken:'test'});app.stopTimers();app.runtime.sessions=async()=>new Set();await app.rooms.save('0',draft());
 return {...app,data,cleanup:async()=>{if(app.server.listening)await new Promise(r=>app.server.close(r));app.close();fs.rmSync(data,{recursive:true,force:true});}};
}
test('room description is saved to the native cluster and imported archives replace it',async()=>{
 const app=await fixture();try{
  assert.equal(app.store.getRoom('0').description,draft().description);assert.match(fs.readFileSync(path.join(app.store.cluster('0'),'cluster.ini'),'utf8'),/cluster_description = 欢迎加入，友好交流\n/);
  const root=path.join(app.data,'imported');fs.mkdirSync(path.join(root,'Master'),{recursive:true});fs.writeFileSync(path.join(root,'cluster.ini'),'[NETWORK]\ncluster_name=Imported\ncluster_description=导入的公告\n');fs.writeFileSync(path.join(root,'Master/server.ini'),'[NETWORK]\nserver_port=11001\n');
  assert.equal(app.saves.importRoomFromCluster('0',root,app.store.getRoom('0')).description,'导入的公告');
  fs.writeFileSync(path.join(root,'cluster.ini'),'[NETWORK]\ncluster_name=No announcement\n');assert.equal(app.saves.importRoomFromCluster('0',root,app.store.getRoom('0')).description,'');
 }finally{await app.cleanup();}
});
test('legacy rooms default to no announcements; invalid content, injection and intervals are rejected',async()=>{
 const app=await fixture();try{
  const legacy=draft();delete legacy.description;delete legacy.announcement;
  const config=(await app.rooms.save('0',legacy)).config;assert.equal(config.description,'');assert.deepEqual(config.announcement,{enabled:false,message:'',intervalMinutes:30});
  for(const patch of [{description:'x\n[NETWORK]\nmax_players=64'},{description:'x'.repeat(257)},{announcement:{enabled:true,message:'  ',intervalMinutes:5}},{announcement:{enabled:'true',message:'hello',intervalMinutes:5}},{announcement:{enabled:true,message:'x'.repeat(501),intervalMinutes:5}},{announcement:{enabled:true,message:'x',intervalMinutes:0}},{announcement:{enabled:true,message:'x',intervalMinutes:2.5}},{announcement:{enabled:true,message:'x',intervalMinutes:1441}}])await assert.rejects(()=>app.rooms.save('0',{...draft(),...patch}));
 }finally{await app.cleanup();}
});
test('manual announcements escape Lua safely, broadcast only once from master and report submission accurately',async()=>{
 const app=await fixture();try{
  const message='你好 "朋友" \\ quote\n\"); error("bad") --';await app.rooms.save('0',{...draft(),announcement:{enabled:false,message,intervalMinutes:5}});
  const commands=[];app.runtime.status=async()=>[{directory:'Master',running:true},{directory:'Caves',running:true}];app.runtime.command=async(...args)=>commands.push(args);
  assert.deepEqual(await app.announcements.send('0'),{submitted:true});assert.deepEqual(commands,[['0',`c_announce(${lua(message)})`,['Master']]]);
  app.runtime.status=async()=>[{directory:'Master',running:false},{directory:'Caves',running:true}];await assert.rejects(()=>app.announcements.send('0'),/主世界未运行/);
  assert.equal(commands.length,1);app.store.sharedBusy=true;await assert.rejects(()=>app.announcements.send('0'),/正在更新/);
 }finally{await app.cleanup();}
});
test('periodic announcements wait for the interval, coalesce polling, pause while stopped and retain deduplication',async()=>{
 const app=await fixture();try{
  let running=true,calls=0;app.runtime.status=async()=>[{directory:'Master',running}];app.runtime.command=async()=>{calls++;};
  const at=Date.now();await app.announcements.tick(at);assert.equal(calls,0);
  await app.announcements.tick(at+299999);assert.equal(calls,0);
  await Promise.all([app.announcements.tick(at+300000),app.announcements.tick(at+300000)]);assert.equal(calls,1);
  await app.announcements.tick(at+300001);assert.equal(calls,1);
  running=false;await app.announcements.tick(at+600000);running=true;await app.announcements.tick(at+900000);assert.equal(calls,1);
  await app.announcements.tick(at+1200000);assert.equal(calls,2);
  const room=app.store.getRoom('0');room.announcement.message='新公告';app.store.putRoom('0',room);await app.announcements.tick(at+1500000);assert.equal(calls,2);
  room.announcement.enabled=false;app.store.putRoom('0',room);await app.announcements.tick(at+1800000);assert.equal(calls,2);assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM announcement_runs').get().n,0);
 }finally{await app.cleanup();}
});
test('announcement failures back off; room locks and game updates do not send',async()=>{
 const app=await fixture();try{
  let calls=0;app.runtime.status=async()=>[{directory:'Master',running:true}];app.runtime.command=async()=>{calls++;throw Error('console failed');};const at=Date.now();
  await app.announcements.tick(at);app.store.locks.add('0');await app.announcements.tick(at+300000);assert.equal(calls,0);app.store.locks.clear();
  app.store.sharedBusy=true;await app.announcements.tick(at+300000);assert.equal(calls,0);app.store.sharedBusy=false;
  await app.announcements.tick(at+300000);assert.equal(calls,1);await app.announcements.tick(at+315000);assert.equal(calls,1);await app.announcements.tick(at+360000);assert.equal(calls,2);
 }finally{await app.cleanup();}
});
test('announcement endpoint requires login and distinguishes stopped game from a submitted command',async()=>{
 const app=await fixture();try{
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}/api/rooms/0/announcement`,headers={Authorization:'Bearer '+app.store.adminToken};
  assert.equal((await fetch(base,{method:'POST'})).status,401);assert.equal((await fetch(base,{method:'POST',headers})).status,409);
  app.runtime.status=async()=>[{directory:'Master',running:true}];let commands=0;app.runtime.command=async()=>{commands++;};
  const response=await fetch(base,{method:'POST',headers});assert.equal(response.status,200);assert.equal((await response.json()).data.submitted,true);assert.equal(commands,1);
 }finally{await app.cleanup();}
});
