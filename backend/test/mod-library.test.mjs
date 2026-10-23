import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { exec } from '../src/core.mjs';
import { createPanel } from '../src/server.mjs';

const python=process.env.FEATHER_PYTHON||(process.platform==='win32'?'python':'python3');
const id='3782535279';
function fixture(overrides={}){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-library-'));
  const app=createPanel({data,game:path.join(data,'dst'),python,adminToken:'library-test-admin-token-at-least-24',translationProvider:'off',modRegistry:'',...overrides});
  app.stopTimers();app.store.putRoom('0',{name:'测试房间',worlds:[],mods:[]});app.runtime.status=async()=>[{running:false}];app.mods.details=async()=>({rows:[]});
  return {...app,data,async listen(){app.server.listen(0,'127.0.0.1');await once(app.server,'listening');return 'http://127.0.0.1:'+app.server.address().port;},async cleanup(){if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));app.close();fs.rmSync(data,{recursive:true,force:true});}};
}
async function archive(app,files={['workshop-'+id+'/modinfo.lua']:'name="隐藏模组"\nversion="1.0"\nauthor="Author"\nos.execute("never run this")', ['workshop-'+id+'/modmain.lua']:'-- complete mod', ['workshop-'+id+'/scripts/feature.lua']:'return true'}){
  const file=path.join(app.data,'upload-'+Math.random()+'.zip');
  await exec(python,['-c','import zipfile,json,sys\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:\n for name,text in json.loads(sys.argv[2]).items(): z.writestr(name,text)',file,JSON.stringify(files)]);return file;
}
async function settle(app,taskID){for(let i=0;i<600;i++){const task=app.store.getTask(taskID);if(['failed','succeeded'].includes(task.state))return task;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('task timeout');}
const auth=app=>({Authorization:'Bearer '+app.store.adminToken,'Content-Type':'application/json'});

test('wrapped hidden mod ZIP is recorded, searched, installed offline, and retained after uninstall',async()=>{
  const app=fixture();try{
    const row=await app.mods.library.remember(await archive(app),id);assert.equal(row.name,'隐藏模组');assert.equal(row.version,'1.0');assert.match(row.hash,/^[a-f0-9]{64}$/);
    const search=await app.mods.search({source:'local',searchText:'隐藏'});assert.equal(search.rows[0].id,id);assert.equal(search.total,1);
    let downloads=0;app.mods.downloadRunner=async()=>{downloads++;throw Error('Steam unavailable');};
    const result=await app.mods.download('0',id);assert.equal(result.downloaded,true);assert.equal(downloads,0);assert.ok(fs.existsSync(app.mods.find(id)));
    let installed=await app.mods.installed('0');assert.equal(installed.rows[0].name,'隐藏模组');assert.equal(installed.rows[0].updateState,'local');
    await assert.rejects(app.mods.download('0',id,()=>{},0,{workshop:true}),/重新上传/);
    await app.mods.remove('0',id);assert.equal(app.mods.find(id),null);assert.ok(app.mods.library.entry(id));
    await app.mods.ensureInstalled('0',[id]);assert.ok(app.mods.find(id));assert.equal(downloads,0);
  }finally{await app.cleanup();}
});
test('invalid ZIP, traversal, incomplete mod and corrupt local package never install',async()=>{
  const app=fixture();try{
    const bad=await archive(app,{'../escape.lua':'bad','modinfo.lua':'name="bad"','modmain.lua':''});await assert.rejects(app.mods.library.remember(bad,id),/校验失败/);assert.equal(app.mods.library.entry(id),null);assert.equal(fs.existsSync(path.join(app.data,'mod-library/escape.lua')),false);
    await assert.rejects(app.mods.library.remember(await archive(app,{'modinfo.lua':'name="incomplete"'}),id),/缺少 modmain/);
    const row=await app.mods.library.remember(await archive(app),id);fs.appendFileSync(app.mods.library.package(row.hash),'corruption');
    await assert.rejects(app.mods.download('0',id),/校验失败/);assert.equal(app.mods.find(id),null);
  }finally{await app.cleanup();}
});
test('uploaded replacement is staged while live game keeps original files and version receipt',async()=>{
  const app=fixture();try{
    await app.mods.library.remember(await archive(app),id);await app.mods.download('0',id);app.runtime.status=async()=>[{running:true}];
    await app.mods.library.remember(await archive(app,{'modinfo.lua':'name="新版本"\nversion="2.0"','modmain.lua':'-- new'}),id);
    const result=await app.mods.download('0',id);assert.equal(result.deferred,true);assert.match(fs.readFileSync(path.join(app.mods.find(id),'modinfo.lua'),'utf8'),/1.0/);
    assert.equal((await app.mods.installed('0')).rows[0].version,'1.0');await app.mods.applyPending();assert.match(fs.readFileSync(path.join(app.mods.find(id),'modinfo.lua'),'utf8'),/1.0/);
    app.runtime.status=async()=>[{running:false}];await app.mods.applyPending();assert.match(fs.readFileSync(path.join(app.mods.find(id),'modinfo.lua'),'utf8'),/2.0/);assert.equal((await app.mods.installed('0')).rows[0].version,'2.0');
  }finally{await app.cleanup();}
});
test('shared registry quarantines submissions, protects review, and supports cross-instance verified installation',async()=>{
  const host=fixture({modRegistryHost:true}),client=fixture();try{
    const base=await host.listen();client.config.modRegistry=base;
    const row=await client.mods.library.remember(await archive(client),id);
    await assert.rejects(client.mods.library.submit(id,false),/作者/);
    const submitted=await client.mods.library.submit(id,true);assert.equal(submitted.state,'pending');assert.equal(host.mods.library.rows('pending').length,1);
    assert.equal((await client.mods.search({source:'community',searchText:'隐藏'})).rows.length,0);
    assert.equal((await fetch(base+'/registry/v1/packages/'+row.hash+'.zip')).status,404);
    assert.equal((await fetch(base+'/api/mod-library')).status,401);
    assert.equal((await fetch(base+'/api/mod-library/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hash:row.hash,publish:true})})).status,401);
    const approved=await fetch(base+'/api/mod-library/review',{method:'POST',headers:auth(host),body:JSON.stringify({hash:row.hash,publish:true})});assert.equal(approved.status,200);
    assert.equal(host.mods.library.rows('pending').length,0);
    const search=await client.mods.search({source:'community',searchText:'隐藏'});assert.equal(search.rows[0].id,id);assert.equal(search.rows[0].hash,row.hash);assert.equal(search.rows[0].source,'community-library');
    fs.rmSync(client.mods.library.file('local/'+id+'.json'));fs.rmSync(client.mods.library.package(row.hash));
    const progress=[];const result=await client.mods.download('0',id,p=>progress.push(p),0,{source:'community-library',hash:row.hash});assert.equal(result.downloaded,true);assert.ok(progress.some(p=>p>0));assert.ok(client.mods.find(id));assert.equal(client.mods.library.entry(id).origin,'community-library');
    host.mods.library.unpublish(id);assert.equal((await fetch(base+'/registry/v1/packages/'+row.hash+'.zip')).status,404);assert.ok(client.mods.find(id));
  }finally{await client.cleanup();await host.cleanup();}
});
test('registry checksum mismatch and changed version preserve existing mod files',async()=>{
  const app=fixture();try{
    const row=await app.mods.library.remember(await archive(app),id);await app.mods.download('0',id);const before=fs.readFileSync(path.join(app.mods.find(id),'modinfo.lua'),'utf8');
    app.config.modRegistry='https://registry.invalid';app.mods.library.fetch=async()=>new Response(JSON.stringify({data:{...row,hash:'a'.repeat(64)}}),{status:200});
    await assert.rejects(app.mods.download('0',id,()=>{},0,{source:'community-library',hash:row.hash}),/版本已变化/);
    let calls=0;app.mods.library.fetch=async()=>++calls===1?new Response(JSON.stringify({data:row}),{status:200}):new Response(Buffer.alloc(row.size),{status:200});
    await assert.rejects(app.mods.download('0',id,()=>{},0,{source:'community-library',hash:row.hash}),/校验失败/);assert.equal(fs.readFileSync(path.join(app.mods.find(id),'modinfo.lua'),'utf8'),before);
  }finally{await app.cleanup();}
});
test('registry host is opt-in and submission reservations enforce concurrency and hourly quotas',async()=>{
  const app=fixture(),host=fixture({modRegistryHost:true});try{
    const base=await app.listen();assert.equal((await fetch(base+'/registry/v1/mods')).status,404);assert.throws(()=>app.mods.library.reserve('ip'),/未开启/);
    const release=host.mods.library.reserve('one');assert.throws(()=>host.mods.library.reserve('two'),/队列/);release();
    host.mods.library.reserve('one')();host.mods.library.reserve('one')();assert.throws(()=>host.mods.library.reserve('one'),/每小时/);assert.equal(host.mods.library.receiving,0);
    host.config.modLibraryLimit=1;await assert.rejects(host.mods.library.remember(await archive(host),id),error=>error.status===507);assert.equal(host.mods.library.entry(id),null);
  }finally{await app.cleanup();await host.cleanup();}
});
test('authenticated ZIP upload validates input and returns an installation task',async()=>{
  const app=fixture();try{
    const base=await app.listen(),file=await archive(app),bytes=fs.readFileSync(file);
    assert.equal((await fetch(base+'/api/rooms/0/mods/upload?id='+id+'&filename=mod.zip',{method:'POST',headers:{'Content-Type':'application/zip'},body:bytes})).status,401);
    const response=await fetch(base+'/api/rooms/0/mods/upload?id='+id+'&filename=mod.zip',{method:'POST',headers:{Authorization:'Bearer '+app.store.adminToken,'Content-Type':'application/zip'},body:bytes});assert.equal(response.status,202);
    const task=await settle(app,(await response.json()).data.taskID);assert.equal(task.state,'succeeded');assert.ok(app.mods.find(id));assert.equal(app.mods.library.rows().length,1);
  }finally{await app.cleanup();}
});
