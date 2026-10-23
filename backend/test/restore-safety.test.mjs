import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPanel} from '../src/server.mjs';
import {Fault,exec} from '../src/core.mjs';
import {SaveTransaction} from '../src/save-transaction.mjs';
import {retryWorkshop,downloadWorkshop} from '../src/workshop-download.mjs';
import {presets} from '../src/lua.mjs';

const python=process.env.FEATHER_PYTHON||(process.platform==='win32'?'python':'python3');
async function fixture(){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-restore-'));
  const app=createPanel({data,game:path.join(data,'dst'),steam:path.join(data,'steam'),python});app.stopTimers();
  app.runtime.sessions=async()=>new Set();
  await app.rooms.save('0',{name:'Original',password:'',maxPlayers:6,mode:'endless',pvp:false,pause:true,vote:true,worldCount:1,worlds:[{directory:'Master',type:'forest',port:11001,levelData:presets.endless.master}],mods:[],automation:{backupTime:'06:00',autoBackup:false,startType:'64-bit'}});
  app.runtime.status=async()=>[{directory:'Master',running:false}];
  app.cleanup=()=>{app.close();fs.rmSync(data,{recursive:true,force:true});};return app;
}
async function upload(app,mods='return {}'){
  const entries={'cluster.ini':'[NETWORK]\ncluster_name=Imported\n','Master/server.ini':'[NETWORK]\nserver_port=11001\n','Master/save/session/ABCDEF0123456789/0000000001':'imported world','Master/modoverrides.lua':mods};
  const file=path.join(app.config.data,'input.zip');
  await exec(python,['-c','import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); [z.writestr(k,v) for k,v in json.loads(sys.argv[2]).items()];z.close()',file,JSON.stringify(entries)]);
  return (await app.saves.upload('0',file,'Test')).save.id;
}

test('transient workshop errors retry with backoff and preserve the final failure',async()=>{
  const waits=[],events=[];let calls=0;
  const result=await retryWorkshop(async()=>{if(++calls<3)throw new Fault(502,'I/O Operation Failed');return 'validated';},(...event)=>events.push(event),{wait:async ms=>waits.push(ms)});
  assert.equal(result,'validated');assert.equal(calls,3);assert.deepEqual(waits,[3000,6000]);assert.equal(events.length,2);
  calls=0;await assert.rejects(()=>retryWorkshop(async()=>{calls++;throw new Fault(504,'network timeout');},()=>{},{wait:async()=>{}}),/已尝试 3 次.*network timeout/);assert.equal(calls,3);
});
test('private workshop items and unwritable storage stop without pointless retries',async()=>{
  for(const error of [Object.assign(new Fault(502,'private'),{permanent:true}),new Fault(507,'disk')]){
    let calls=0;await assert.rejects(()=>retryWorkshop(async()=>{calls++;throw error;},()=>{},{wait:async()=>{}}),error);assert.equal(calls,1);
  }
});
test('a stale worker modinfo file cannot bypass Steam validation',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-stale-'));
  try{
    const worker=path.join(data,'workshop-workers/worker-0'),runtime=path.join(worker,'steamcmd'),source=path.join(worker,'download/steamapps/workshop/content/322330/123456789');
    fs.mkdirSync(source,{recursive:true});fs.writeFileSync(path.join(source,'modinfo.lua'),'partial download');
    fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(path.join(runtime,'steamcmd.sh'),'not executable');
    await assert.rejects(()=>downloadWorkshop({data,steam:runtime},'123456789',0,()=>{}),/已尝试 3 次/);
  }finally{fs.rmSync(data,{recursive:true,force:true});}
});
test('a missing mod download failure leaves the live room running and releases its lock',async()=>{
  const app=await fixture();try{
    const saveID=await upload(app,'return {["workshop-123456789"]={enabled=true}}'),previous=app.store.getRoom('0');
    let stops=0;app.runtime.status=async()=>[{directory:'Master',running:true}];app.runtime.stop=async()=>{stops++;};
    app.mods.ensureInstalled=async()=>{throw new Fault(502,'Steam unavailable');};
    await assert.rejects(()=>app.store.locked('0',()=>app.saves.restore('0',saveID)),/Steam unavailable/);
    assert.equal(stops,0);assert.deepEqual(app.store.getRoom('0'),previous);assert.match(fs.readFileSync(path.join(app.store.cluster('0'),'cluster.ini'),'utf8'),/Original/);assert.equal(app.store.locks.size,0);
  }finally{app.cleanup();}
});
test('a replacement write failure restores files and the room row',async()=>{
  const app=await fixture();try{
    const saveID=await upload(app),previous=app.store.getRoom('0'),put=app.store.putRoom.bind(app.store);
    app.store.putRoom=(id,room)=>{if(room.name==='Imported')throw Error('database write failed');return put(id,room);};
    await assert.rejects(()=>app.store.locked('0',()=>app.saves.restore('0',saveID)),/database write failed/);
    assert.deepEqual(app.store.getRoom('0'),previous);assert.match(fs.readFileSync(path.join(app.store.cluster('0'),'cluster.ini'),'utf8'),/Original/);assert.equal(SaveTransaction.pending(app.store).length,0);assert.equal(app.store.locks.size,0);
  }finally{app.cleanup();}
});
test('failure to roll back preserves the journal and old save and blocks later mutations',async()=>{
  const app=await fixture();try{
    const saveID=await upload(app),previous=app.store.getRoom('0'),put=app.store.putRoom.bind(app.store);
    app.store.putRoom=()=>{throw Error('database unavailable');};
    await assert.rejects(()=>app.store.locked('0',()=>app.saves.restore('0',saveID)),/自动回滚未完成/);
    const [pending]=SaveTransaction.pending(app.store);assert.ok(pending);assert.match(fs.readFileSync(path.join(pending.current,'cluster.ini'),'utf8'),/Original/);
    await assert.rejects(()=>app.store.locked('0',async()=>{}),/自动回滚未完成/);
    app.store.putRoom=put;pending.rollback();app.store.restoreBlocked.clear();assert.deepEqual(app.store.getRoom('0'),previous);
  }finally{app.cleanup();}
});
test('restart recovers a filesystem swap before the database update',async()=>{
  const app=await fixture();let reopened;try{
    const previous=app.store.getRoom('0'),transaction=SaveTransaction.create(app.store,'0',previous);
    fs.mkdirSync(transaction.prepared);fs.writeFileSync(path.join(transaction.prepared,'cluster.ini'),'imported');transaction.save();
    fs.renameSync(transaction.current,transaction.previous);fs.renameSync(transaction.prepared,transaction.current);
    app.close();reopened=createPanel(app.config);reopened.stopTimers();reopened.runtime.sessions=async()=>new Set();await reopened.saves.recovery;
    assert.deepEqual(reopened.store.getRoom('0'),previous);assert.match(fs.readFileSync(path.join(reopened.store.cluster('0'),'cluster.ini'),'utf8'),/Original/);assert.equal(SaveTransaction.pending(reopened.store).length,0);assert.equal(reopened.store.locks.size,0);
  }finally{if(reopened)reopened.close();else app.close();fs.rmSync(app.config.data,{recursive:true,force:true});}
});

test('invalid imported mod Lua fails before stopping the current game',async()=>{
  const app=await fixture();try{
    const saveID=await upload(app,'return unsafe_function()');let stopped=false;
    app.runtime.status=async()=>[{directory:'Master',running:true}];app.runtime.stop=async()=>{stopped=true;};
    await assert.rejects(()=>app.saves.restore('0',saveID),/模组配置读取失败/);assert.equal(stopped,false);assert.equal(app.store.getRoom('0').name,'Original');
  }finally{app.cleanup();}
});
test('startup failure stops the imported world before restoring and restarting the original',async()=>{
  const app=await fixture();try{
    const saveID=await upload(app),calls=[];let running=true;
    app.runtime.status=async()=>[{directory:'Master',running}];
    app.runtime.stop=async()=>{calls.push('stop '+app.store.getRoom('0').name);running=false;};
    app.runtime.start=async()=>{const name=app.store.getRoom('0').name;calls.push('start '+name);running=true;if(name==='Imported')throw Error('start failed');};
    await assert.rejects(()=>app.saves.restore('0',saveID),/start failed/);
    assert.deepEqual(calls,['stop Original','start Imported','stop Imported','start Original']);assert.equal(app.store.getRoom('0').name,'Original');assert.equal(running,true);
  }finally{app.cleanup();}
});
test('recovery covers interruption between renames, after the database write and after commit',async()=>{
  for(const phase of ['first-rename','database-written','committed']){
    const app=await fixture();let reopened;try{
      const original=app.store.getRoom('0'),transaction=SaveTransaction.create(app.store,'0',original);
      fs.mkdirSync(transaction.prepared);fs.writeFileSync(path.join(transaction.prepared,'cluster.ini'),'imported');transaction.save();fs.renameSync(transaction.current,transaction.previous);
      if(phase!=='first-rename'){fs.renameSync(transaction.prepared,transaction.current);app.store.putRoom('0',{...original,name:'Imported'});}
      if(phase==='committed')transaction.commit();
      app.close();reopened=createPanel(app.config);reopened.stopTimers();reopened.runtime.sessions=async()=>new Set();await reopened.saves.recovery;
      const expected=phase==='committed'?'Imported':'Original';assert.equal(reopened.store.getRoom('0').name,expected);assert.match(fs.readFileSync(path.join(transaction.current,'cluster.ini'),'utf8'),phase==='committed'?/imported/:/Original/);assert.equal(SaveTransaction.pending(reopened.store).length,0);
    }finally{if(reopened)reopened.close();else app.close();fs.rmSync(app.config.data,{recursive:true,force:true});}
  }
});
test('a failed commit journal write remains eligible for rollback',async()=>{
  const app=await fixture();try{
    const original=app.store.getRoom('0'),transaction=SaveTransaction.create(app.store,'0',original);
    fs.mkdirSync(transaction.prepared);fs.writeFileSync(path.join(transaction.prepared,'cluster.ini'),'imported');transaction.swap({...original,name:'Imported'});
    const save=transaction.save.bind(transaction);transaction.save=()=>{throw Error('disk full');};
    assert.throws(()=>transaction.commit(),/disk full/);assert.equal(transaction.record.phase,'ready');
    transaction.save=save;transaction.rollback();assert.deepEqual(app.store.getRoom('0'),original);assert.match(fs.readFileSync(path.join(transaction.current,'cluster.ini'),'utf8'),/Original/);
  }finally{app.cleanup();}
});
