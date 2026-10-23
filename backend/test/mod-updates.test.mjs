import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPanel} from '../src/server.mjs';
import {presets} from '../src/lua.mjs';
import {ModUpdates} from '../src/mod-updates.mjs';
const draft=()=>({name:'自动更新测试',password:'',maxPlayers:6,mode:'endless',pvp:false,pause:true,vote:true,worldCount:1,worlds:[{directory:'Master',type:'forest',port:11001,levelData:presets.endless.master}],mods:[],automation:{autoBackup:false,backupTime:'06:00',startType:'64-bit'}});
async function fixture(){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-autoupdate-')),app=createPanel({data,game:path.join(data,'dst'),translationProvider:'off',clusterToken:'test'});app.stopTimers();app.runtime.sessions=async()=>new Set();await app.rooms.save('0',draft());
 const versions=new Map(),downloads=[];let fail=false;
 const add=(id,local=100,latest=200)=>{const folder=path.join(app.config.game,'mods/workshop-'+id);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'modinfo.lua'),'name="original"');if(local!==null){fs.mkdirSync(path.dirname(app.mods.receipt(id)),{recursive:true});fs.writeFileSync(app.mods.receipt(id),JSON.stringify({timeUpdated:local}));}versions.set(id,latest);};
 app.mods.details=async ids=>({source:'steam',rows:ids.map(id=>({id,name:'测试模组 '+id,version:String(versions.get(id))}))});
 app.mods.revision=id=>({timeUpdated:versions.get(id)});
 app.mods.downloadRunner=async(config,id)=>{downloads.push(id);if(fail)throw Error('Steam timeout');const folder=path.join(data,'source-'+id);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'modinfo.lua'),'name="updated"');return folder;};
 const settle=async()=>{for(let i=0;i<200&&app.mods.jobs.size;i++)await new Promise(r=>setTimeout(r,10));assert.equal(app.mods.jobs.size,0);await new Promise(r=>setImmediate(r));};
 return {...app,data,versions,downloads,add,settle,setFail:value=>fail=value,cleanup:async()=>{await settle();if(app.server.listening)await new Promise(r=>app.server.close(r));app.close();fs.rmSync(data,{recursive:true,force:true});}};
}
test('background checks stage all installed updates without changing stopped game files, config or launching worlds',async()=>{
 const f=await fixture();try{
  f.add('123456781');f.add('123456782');f.add('123456783',200,200);let startCalls=0;f.runtime.start=async()=>startCalls++;
  const config=f.store.getRoom('0'),at=Date.now();assert.equal((await f.modUpdates.tick(at)).queued,2);await f.settle();
  assert.deepEqual(f.downloads.sort(),['123456781','123456782']);assert.equal(startCalls,0);assert.deepEqual(f.store.getRoom('0'),config);
  for(const id of f.downloads){assert.match(fs.readFileSync(path.join(f.mods.find(id),'modinfo.lua'),'utf8'),/original/);assert.match(fs.readFileSync(path.join(f.mods.pending(id),'files/modinfo.lua'),'utf8'),/updated/);}
  assert.equal(f.modUpdates.list().unread,2);assert.ok(f.modUpdates.list().rows.every(row=>row.payload.deferred));
  await f.modUpdates.tick(at+15*60000);await f.settle();assert.equal(f.downloads.length,2);assert.equal(f.modUpdates.list().rows.length,2);
  await f.mods.applyPending();assert.match(fs.readFileSync(path.join(f.mods.find('123456781'),'modinfo.lua'),'utf8'),/updated/);
 }finally{await f.cleanup();}
});
test('newer versions replace pending updates, preserving latest receipt and a separate completed notification',async()=>{
 const f=await fixture();try{f.add('123456781');const at=Date.now();await f.modUpdates.tick(at);await f.settle();f.versions.set('123456781',300);await f.modUpdates.tick(at+15*60000);await f.settle();assert.equal(f.downloads.length,2);assert.equal(JSON.parse(fs.readFileSync(path.join(f.mods.pending('123456781'),'revision.json'))).timeUpdated,300);assert.equal(f.modUpdates.list().rows.length,2);}finally{await f.cleanup();}
});
test('cached outages and unknown local revisions never trigger blind automatic updates',async()=>{
 const f=await fixture();try{f.add('123456781',null);await f.modUpdates.tick();assert.equal(f.downloads.length,0);assert.match(f.modUpdates.status().error,/缺少本地版本/);f.mods.details=async()=>({source:'cache',warning:'Steam unavailable',rows:[{id:'123456781',version:'300'}]});await f.modUpdates.tick(Date.now()+15*60000);assert.match(f.modUpdates.status().error,/Steam unavailable/);assert.equal(f.downloads.length,0);}finally{await f.cleanup();}
});
test('disabled setting persists and locks, update intervals and concurrent ticks prevent duplicate jobs',async()=>{
 const f=await fixture();try{
  f.add('123456781');f.modUpdates.configure(false);assert.equal(new ModUpdates(f.store,f.mods).status().enabled,false);await f.modUpdates.tick();assert.equal(f.downloads.length,0);
  f.modUpdates.configure(true);f.store.sharedBusy=true;await f.modUpdates.tick();f.store.sharedBusy=false;f.store.locks.add('0');await f.modUpdates.tick();f.store.locks.clear();assert.equal(f.downloads.length,0);
  const at=Date.now();await Promise.all([f.modUpdates.tick(at),f.modUpdates.tick(at)]);await f.settle();await f.modUpdates.tick(at+1000);assert.equal(f.downloads.length,1);
 }finally{await f.cleanup();}
});
test('failed automatic updates preserve files, notify, back off and stop after three attempts per version',async()=>{
 const f=await fixture();try{
  f.add('123456781');f.setFail(true);const at=Date.now();await f.modUpdates.tick(at);await f.settle();await f.modUpdates.tick(at+1000);assert.equal(f.modUpdates.list().rows[0].kind,'mod-update-failed');assert.equal(f.downloads.length,1);
  for(const offset of [15,30,45]){await f.modUpdates.tick(at+offset*60000);await f.settle();}
  await f.modUpdates.tick(at+60*60000);assert.equal(f.downloads.length,3);assert.equal(f.modUpdates.list().rows.length,3);assert.match(fs.readFileSync(path.join(f.mods.find('123456781'),'modinfo.lua'),'utf8'),/original/);
  f.versions.set('123456781',300);f.setFail(false);await f.modUpdates.tick(at+75*60000);await f.settle();assert.equal(f.downloads.length,4);
 }finally{await f.cleanup();}
});
test('completed tasks recover missed notifications and cursor-based read never marks later messages',async()=>{
 const f=await fixture();try{
  f.add('123456781');f.mods.onUpdated=undefined;const at=Date.now();await f.modUpdates.tick(at);await f.settle();assert.equal(f.modUpdates.list().rows.length,0);
  const service=new ModUpdates(f.store,f.mods);await service.tick(at+1000);assert.equal(service.list().unread,1);const through=service.list().rows[0].id;
  service.notify('later','mod-updated','later',{name:'later'});assert.equal(service.markRead(through).unread,1);await service.tick(at+2000);assert.equal(service.list().rows.length,2);assert.throws(()=>service.markRead(-1));
 }finally{await f.cleanup();}
});
test('manual updates create success mail, but first-time downloads do not',async()=>{
 const f=await fixture();try{f.add('123456781');f.mods.enqueue('0','123456781');await f.settle();assert.equal(f.modUpdates.list().rows.length,1);assert.equal(f.modUpdates.list().rows[0].payload.deferred,false);f.versions.set('123456782',200);f.mods.enqueue('0','123456782');await f.settle();assert.equal(f.modUpdates.list().rows.length,1);}finally{await f.cleanup();}
});
test('inbox, read and automation APIs require authentication and reject cross-site or invalid writes',async()=>{
 const f=await fixture();try{
  await new Promise(r=>f.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${f.server.address().port}/api`,headers={Authorization:'Bearer '+f.store.adminToken,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/inbox')).status,401);assert.equal((await fetch(base+'/workshop/auto-update',{method:'PUT',headers,body:'{"enabled":"yes"}'})).status,400);
  assert.equal((await fetch(base+'/inbox/read',{method:'POST',headers,body:'{"through":-1}'})).status,400);assert.equal((await fetch(base+'/inbox/read',{method:'POST',headers:{...headers,Origin:'http://evil.invalid'},body:'{"through":1}'})).status,403);
  assert.equal((await fetch(base+'/workshop/auto-update',{method:'PUT',headers,body:'{"enabled":false}'})).status,200);assert.equal((await(await fetch(base+'/inbox',{headers})).json()).data.enabled,false);
 }finally{await f.cleanup();}
});
