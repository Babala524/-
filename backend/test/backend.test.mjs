import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';
import { once } from 'node:events';
import { createPanel } from '../src/server.mjs';
import { presets, levelData, savedLevelSource, lua, modFields } from '../src/lua.mjs';
import { inside, exec } from '../src/core.mjs';
import { Runtime } from '../src/runtime.mjs';
import { Telemetry } from '../src/telemetry.mjs';
import { configuration } from '../src/core.mjs';
import { defaultSteamApiKey } from '../src/upstream-default.mjs';
import { installedRevision, contentProgress } from '../src/workshop-state.mjs';
import { translateModFields, translateModText } from '../src/mod-translations.mjs';
import { downloadLegacy } from '../src/workshop-download.mjs';
import { findLua } from '../src/lua-find.mjs';

const settle=async(store,taskID)=>{
  for(let i=0;i<300;i++){const task=store.getTask(taskID);if(['succeeded','failed'].includes(task.state))return task;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('task timeout');
};
test('parallel workshop jobs use three independent slots, queue overflow, deduplicate IDs and publish complete files',async()=>{
  const app=fixture();const releases=new Map(),started=[];
  try{
    await app.rooms.save('0',draft());app.runtime.status=async()=>[{running:true}];
    app.mods.details=async()=>({rows:[]});
    app.mods.downloadRunner=async(config,id,slot,report)=>{
      started.push({id,slot});report(null,'downloading',{stage:'downloading'});
      await new Promise((resolve,reject)=>releases.set(id,{resolve,reject}));
      const source=path.join(app.data,'source-'+id);fs.mkdirSync(source);fs.writeFileSync(path.join(source,'modinfo.lua'),'name="test"');return source;
    };
    const ids=['123456781','123456782','123456783','123456784'],jobs=ids.map(id=>app.mods.enqueue('0',id));
    assert.equal(app.mods.enqueue('0',ids[0]).taskID,jobs[0].taskID);
    await new Promise(resolve=>setTimeout(resolve,40));assert.equal(started.length,3);assert.equal(new Set(started.map(row=>row.slot)).size,3);
    const progress=app.store.getTask(jobs[0].taskID).result;assert.equal(progress.progress,null);assert.equal(progress.stage,'downloading');
    assert.equal(app.store.getTask(jobs[3].taskID).result.stage,'queued');
    releases.get(ids[0]).reject(Error('steam offline'));
    assert.equal((await settle(app.store,jobs[0].taskID)).state,'failed');
    for(let i=0;i<30&&!releases.has(ids[3]);i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(started[3].slot,started[0].slot);
    for(const id of ids.slice(1))releases.get(id).resolve();
    const results=await Promise.all(jobs.slice(1).map(job=>settle(app.store,job.taskID)));assert.ok(results.every(row=>row.state==='succeeded'));
    assert.equal(app.mods.jobs.size,0);assert.equal(app.mods.slots.size,0);assert.equal(app.store.sharedBusy,false);
    assert.equal((await app.mods.installed('0')).rows.length,3);
    app.mods.downloadRunner=async()=>{const source=path.join(app.data,'new-version');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'modinfo.lua'),'name="updated"');return source;};
    const original=fs.readFileSync(path.join(app.config.game,'mods/workshop-'+ids[1]+'/modinfo.lua'),'utf8');
    const retry=app.mods.enqueue('0',ids[1]);const staged=await settle(app.store,retry.taskID);assert.equal(staged.state,'succeeded');assert.equal(staged.result.deferred,true);
    assert.equal(fs.readFileSync(path.join(app.config.game,'mods/workshop-'+ids[1]+'/modinfo.lua'),'utf8'),original);
    await app.mods.applyPending();assert.equal(fs.readFileSync(path.join(app.config.game,'mods/workshop-'+ids[1]+'/modinfo.lua'),'utf8'),original);
    app.runtime.status=async()=>[{running:false}];await app.mods.applyPending();assert.match(fs.readFileSync(path.join(app.config.game,'mods/workshop-'+ids[1]+'/modinfo.lua'),'utf8'),/updated/);
    assert.equal(started.length,4);
    assert.equal(app.mods.downloads().rows.filter(row=>row.modID===ids[1]).length,1);
  }finally{for(const release of releases.values())release.resolve();await app.cleanup();}
});
test('installed workshop icons survive metadata responses without a cover',async()=>{
  const app=fixture();try{
    await app.rooms.save('0',draft());
    const id='378160973',folder=path.join(app.config.game,'mods/workshop-'+id);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'modinfo.lua'),'name="Positions"');
    fs.mkdirSync(path.dirname(app.mods.metadata(id)),{recursive:true});fs.writeFileSync(app.mods.metadata(id),JSON.stringify({name:'Positions',preview_url:'https://images.steamusercontent.com/icon.jpg'}));
    app.mods.fetch=async()=>({ok:true,json:async()=>({response:{publishedfiledetails:[{result:1,consumer_app_id:322330,publishedfileid:id,title:'Positions'}]}})});
    await app.mods.details([id]);assert.equal((await app.mods.installed('0')).rows[0].preview_url,'https://images.steamusercontent.com/icon.jpg');
  }finally{await app.cleanup();}
});

test('workshop versions compare installed manifest with latest details and preserve unknown/pending states',async()=>{
 const app=fixture();try{
  await app.rooms.save('0',draft());const id='378160973',folder=path.join(app.config.game,'mods/workshop-'+id);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'modinfo.lua'),'name="test"');
  const manifest=path.join(app.config.game,'steamapps/workshop/appworkshop_322330.acf');fs.mkdirSync(path.dirname(manifest),{recursive:true});fs.writeFileSync(manifest,'"WorkshopItemsInstalled" { "378160973" { "timeupdated" "100" "manifest" "1" } } "WorkshopItemDetails" { "378160973" { "timeupdated" "999" } }');
  assert.equal(installedRevision(manifest,id).timeUpdated,100);
  app.mods.fetch=async()=>({ok:true,json:async()=>({response:{publishedfiledetails:[{result:1,consumer_app_id:322330,publishedfileid:id,title:'test',time_updated:200,preview_url:'https://images.steamusercontent.com/a'}]}})});
  let row=(await app.mods.installed('0',true)).rows[0];assert.equal(row.updateState,'outdated');assert.equal(row.installedUpdatedAt,100);assert.equal(row.latestUpdatedAt,200);
  fs.mkdirSync(path.join(app.mods.pending(id),'files'),{recursive:true});fs.writeFileSync(path.join(app.mods.pending(id),'files/modinfo.lua'),'name="new"');assert.equal((await app.mods.installed('0')).rows[0].updateState,'pending');
  fs.rmSync(app.mods.pending(id),{recursive:true});fs.writeFileSync(app.mods.receipt(id),JSON.stringify({timeUpdated:200}));assert.equal((await app.mods.installed('0')).rows[0].updateState,'current');
  fs.writeFileSync(app.mods.receipt(id),'{}');assert.equal((await app.mods.installed('0')).rows[0].updateState,'unknown');
 }finally{await app.cleanup();}
});

test('download progress reads actual transferred bytes and legacy HTTP files are verified before install',async()=>{
 assert.deepEqual(contentProgress('App update started : download 250/1000, stage 0/4000'),{downloadedBytes:250,totalBytes:1000,progress:25,progressSource:'steam-bytes'});
 assert.equal(contentProgress('download 0/0'),null);
 const app=fixture();try{
  const id='458587300',file=await archive(app,'mod-http.zip',{'modinfo.lua':'name="travel"','modmain.lua':'return {}'}),bytes=fs.readFileSync(file);
  fs.mkdirSync(path.dirname(app.mods.metadata(id)),{recursive:true});fs.writeFileSync(app.mods.metadata(id),JSON.stringify({file_url:'https://steamusercontent.com/test',version:'200'}));
  const events=[];const source=await downloadLegacy(app.config,id,0,(progress,message,detail)=>events.push({progress,...detail}),async()=>new Response(bytes,{headers:{'content-length':String(bytes.length)}}));
  assert.match(fs.readFileSync(path.join(source,'modinfo.lua'),'utf8'),/travel/);assert.ok(events.some(event=>event.progressSource==='http-bytes'&&event.totalBytes===bytes.length));
  assert.equal(events.at(-1).progress,100);
 }finally{await app.cleanup();}
});

test('Chinese mod text changes display only and keeps unknown text and Lua option values',()=>{
 const original=[{name:'SHOWPLAYERICONS',label:'Player Icons',hover:'The player icons on the map.',default:false,options:[{description:'Enabled',data:true},{description:'Unrecognized phrase',data:false}]}];
 const fields=translateModFields(original);assert.equal(fields[0].label,'玩家地图图标');assert.equal(fields[0].options[0].description,'开启');assert.equal(fields[0].options[0].data,true);assert.equal(fields[0].name,'SHOWPLAYERICONS');assert.equal(fields[0].default,false);assert.equal(fields[0].options[1].description,'Unrecognized phrase');assert.equal(fields[0].originalLabel,'Player Icons');assert.equal(original[0].label,'Player Icons');
});
test('reviewed translations preserve full field meaning and original text',()=>{
 const fields=translateModFields([{name:'x',label:'Harder Nightmare Creatures',hover:'Official Soundtrack',default:false,options:[{description:'Disabled',data:false}]}]);
 assert.equal(fields[0].label,'更强的梦魇生物');assert.equal(fields[0].hover,'官方音乐');assert.equal(fields[0].options[0].description,'关闭');assert.equal(fields[0].originalLabel,'Harder Nightmare Creatures');
 assert.match(translateModText('Toggling with Scaled Chests existing in the world may cause a crash.'),/crash/);
 assert.equal(translateModText('Unrecognized setting description'), 'Unrecognized setting description');
 assert.equal(translateModText('Explosion Off'),'关闭爆炸');assert.equal(translateModText('Explosion On'),'开启爆炸');
 assert.match(translateModText('Enabling this buffs Scaled Chest to 25 slots. Toggling with Scaled Chests existing in the world may cause a crash.'),/25.*崩溃/);
});
test('representative reviewed workshop strings localize without dropping warnings or numbers',()=>{
 const sources=[
  ['local function Header(t) return {name="",label=t,options={{description="",data=false}},default=false} end; configuration_options={Header("Core Gameplay"),{name="um_music",label="Official Soundtrack",hover="Disable this if you are crashing when using client music mods or some other incompatibility.",default=true,options={{description="Enabled",data=true},{description="Disabled",data=false}}}}','2039181790'],
  ['configuration_options={{name="language",label="Language",hover="",default="en",options={{description="English",data="en"},{description="Chinese",data="zh"},{description="Portuguese",data="pt"}}}}','2189004162']
 ];
 for(const [source,id] of sources){const fields=translateModFields(modFields(source,'workshop-'+id));const visible=fields.flatMap(f=>[f.label,f.hover,...f.options.map(o=>o.description)]).join('\n');assert.doesNotMatch(visible,/[A-Za-z]{3,}/,id);}
});


const python=process.env.FEATHER_PYTHON||'python3';

test('modinfo data evaluator supports translated, generated and helper function configuration with bounded operations',()=>{
 const fields=modFields([
  'local Ch = locale=="zh" or locale=="zhr"',
  'local options={};for i=0,10,2 do options[i/2+1]={description=""..i,data=i} end',
  'local function title(value) return {name="title",label=value,options={{description="",data=0}},default=0} end',
  'configuration_options={title(Ch and "中文标题" or "Title"),{name="radius",label=ChooseTranslationTable({zh="半径",en="Radius"}),hover="one".."two",options=options,default=4}}'
 ].join('\n'));
 assert.equal(fields[0].label,'中文标题');assert.equal(fields[1].label,'半径');assert.equal(fields[1].hover,'onetwo');assert.equal(fields[1].options.length,6);assert.equal(fields[1].options[2].data,4);
 for(const source of [
  'configuration_options=loadstring("return {}")()',
  'os.execute("bad");configuration_options={}',
  'local function f() return f() end;configuration_options=f()',
  'configuration_options={};for i=1,1000000000 do end',
  'local x={};x.self=x;configuration_options=x'
 ])assert.throws(()=>modFields(source));
 assert.deepEqual(modFields('name="No config";version="1"'),[]);
 assert.equal(modFields('if locale=="zh" then configuration_options={{name="flag",options={{data=false}},default=false}} else configuration_options={} end')[0].name,'flag');
 assert.equal(modFields('local labels={ZH="中文"};local label=labels[locale:upper():sub(0,2)];configuration_options={{name="flag",label=label[1] or label,options={{data=false,description=("%s-%d"):format(label,2)}},default=false}}')[0].options[0].description,'中文-2');
});
test('Uncompromising style folder checks and generated section headings preserve real configuration values',async()=>{
 const source=[
  'local isWorkshop = folder_name:find("^workshop%-%d+$")',
  'local function Header(title) return {name="",label=title,options={{description="",data=false}},default=false} end',
  'local function BinaryConfig(name,label,value) return {name=name,label=label,options={{description="Enabled",data=true},{description="Disabled",data=false}},default=value} end',
  'configuration_options={Header("Core Gameplay"),BinaryConfig("um_music",isWorkshop and "Official Soundtrack" or "Local",false)}'
 ].join('\n');
 const app=fixture();try{
  await app.rooms.save('0',draft());const id='2039181790',folder=path.join(app.config.game,'mods/workshop-'+id);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'modinfo.lua'),source);
  const payload=app.mods.configFields('0',id);assert.equal(payload.fields.length,2);assert.equal(payload.fields[0].name,'');assert.equal(payload.fields[0].label,'核心玩法');assert.equal(payload.fields[1].name,'um_music');assert.equal(payload.fields[1].label,'官方音乐');assert.equal(payload.fields[1].default,false);assert.equal(payload.fields[1].options[1].data,false);
 }finally{await app.cleanup();}
});

test('bounded Lua find handles literal, plain, classes, sets, anchors, ranges and multiple return values',()=>{
 for(const [args,expected] of [
  [['workshop-2039181790','workshop-'],[1,7]],
  [['workshop-2039181790','^workshop%-%d+$'],[1,19]],
  [['a.b','.',1,true],[2,2]],
  [['abc123','[a-z]+%d+'],[1,6]],
  [['ABC','%A+'],null],
  [['a123b456b','a.-b'],[1,5]],
  [['a123b456b','a.*b'],[1,9]],
  [['abc','b',-2],[2,2]],
  [['abc','',4],[4,3]],
  [['abc','',5],null],
  [['abc','[0-9]'],null],
  [['abc','[^0-9]+$'],[1,3]]
 ])assert.deepEqual(findLua(...args),expected,JSON.stringify(args));
 let remaining=100;assert.throws(()=>findLua('a'.repeat(2000),'a*a*a*a*b',1,false,()=>{if(--remaining<0)throw Error('budget');}),/budget/);
 assert.throws(()=>findLua('abc','%b{}'),/暂不支持/);
 const fields=modFields('local function locate(s) return s:find("%d+"), false end;local start,flag=locate("x42");local a,b=("x42"):find("%d+");configuration_options={{name="range",label=""..a.."-"..b,default=flag,options={{data=start},{data=flag}}}}');
 assert.equal(fields[0].label,'2-3');assert.equal(fields[0].default,false);assert.equal(fields[0].options[0].data,2);
});

test('custom Lua iterators and folder identity support Insight style translated generated options within bounds',()=>{
 const source=[
  'local function each(t) return function(t,i) i=i+1;if t[i]~=nil then return i,t[i] end end,t,0 end',
  'local choices={};for i,v in each({false,true}) do choices[i]={description=""..i,data=v} end',
  'configuration_options={{name="switch",label=folder_name=="workshop-2189004162" and ChooseTranslationTable({zh="选项",en="Option"}) or "wrong",default=false,options=choices}}'
 ].join('\n');
 const fields=modFields(source,'workshop-2189004162');assert.equal(fields[0].label,'选项');assert.equal(fields[0].options.length,2);assert.equal(fields[0].options[0].data,false);assert.equal(fields[0].options[1].data,true);
 assert.throws(()=>modFields('local function each(t,i) return 1,true end;configuration_options={};for i,v in each do end'),/限制/);
});
test('dynamic option functions are exposed as editable raw-value fields instead of disappearing',()=>{
 const fields=modFields('configuration_options={{name="dynamic",label="Dynamic",options=(function() return {} end),default={"x"}}}');
 assert.equal(fields.length,1);assert.equal(fields[0].dynamicOptions,true);assert.deepEqual(fields[0].options,[]);
});

test('check action queries Klei lobby listings, matches address and port and does not report duplicate names as this server',async()=>{
 const app=fixture();try{
  await app.rooms.save('0',draft());app.config.publicHost='203.0.113.10';
  let calls=0;
  app.lobby.fetch=async url=>{calls++;return {ok:true,arrayBuffer:async()=>zlib.gzipSync(Buffer.from(JSON.stringify({GET:[
   {name:'朋友联机',maxconnections:12,__addr:'203.0.113.11',port:11001},
   {name:'朋友联机',maxconnections:12,__addr:'203.0.113.10',port:11001,connected:2,__rowId:'actual'}
  ]}))) };};
  const result=await app.lobby.check('0');assert.equal(result.listed,true);assert.ok(result.matches.every(row=>row.lobbyID==='actual'));
  const before=calls;await app.lobby.check('0');assert.equal(calls,before);
  app.lobby.cache.clear();app.lobby.fetch=async()=>({ok:true,arrayBuffer:async()=>Buffer.from(JSON.stringify({GET:[{name:'朋友联机',maxconnections:12,__addr:'203.0.113.11',port:11001}]}))});
  assert.equal((await app.lobby.check('0')).listed,false);
  app.lobby.cache.clear();app.lobby.fetch=async()=>{throw Error('offline');};await assert.rejects(()=>app.lobby.check('0'),/无法访问/);
 }finally{await app.cleanup();}
});


test('start applies selected mods to every world and preserves room settings; missing downloads do not stop a live room',async()=>{
 const app=fixture();try{
  await app.rooms.save('0',draft());let running=true;const calls=[];
  app.runtime.status=async()=>[{running}];
  app.runtime.stop=async()=>{calls.push('stop');running=false;};
  app.runtime.start=async()=>{calls.push('start');running=true;return {requested:true};};
  const original=app.store.getRoom('0'),mods=[{id:'378160973',name:'Positions',enabled:true,config:{show:false}}];
  const folder=path.join(app.config.game,'mods/workshop-378160973');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'modinfo.lua'),'name="Positions"');
  const result=await app.rooms.control('0','start',mods);assert.equal(result.modsSaved,true);assert.equal(result.restarted,true);assert.deepEqual(calls,['stop','start']);
  const saved=app.store.getRoom('0');assert.equal(saved.password,original.password);assert.equal(saved._clusterKey,original._clusterKey);assert.deepEqual(saved._ports,original._ports);
  for(const world of saved.worlds){const source=fs.readFileSync(path.join(app.store.cluster('0'),world.directory,'modoverrides.lua'),'utf8');assert.match(source,/workshop-378160973/);assert.match(source,/\["show"\]\s*=\s*false/);}
  calls.length=0;await assert.rejects(()=>app.rooms.control('0','restart',[{id:'999999999',name:'Missing',enabled:true,config:{}}]),/尚未安装/);assert.deepEqual(calls,[]);assert.equal(running,true);
  await app.rooms.control('0','start',mods);assert.deepEqual(calls,['start']);
  calls.length=0;await app.rooms.control('0','restart',mods);assert.deepEqual(calls,['stop','start']);
  assert.equal(app.store.locks.size,0);
 }finally{await app.cleanup();}
});
test('running room accepts full saves and marks them for restart',async()=>{
 const app=fixture();try{
  const input=draft();input.mods=[];await app.rooms.save('0',input);
  app.runtime.status=async()=>[{running:true}];
  const folder=path.join(app.config.game,'mods/workshop-378160973');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'modinfo.lua'),'name="Positions"');
  const selected={...app.rooms.public(app.store.getRoom('0')),mods:draft().mods};
  const result=await app.rooms.save('0',selected);assert.equal(result.requiresRestart,true);assert.equal(app.store.getRoom('0').mods[0].enabled,true);
  const changed={...selected,name:'changed room'};
  const changedResult=await app.rooms.save('0',changed);assert.equal(changedResult.requiresRestart,true);assert.equal(app.store.getRoom('0').name,'changed room');
 }finally{await app.cleanup();}
});


test('legacy workshop ZIP extraction validates files and rejects escaping paths',async()=>{
  const app=fixture();try{
    const source=await archive(app,'legacy.bin',{'modinfo.lua':'name="Legacy"','scripts\\data.lua':'return {}'});
    const folder=path.join(app.data,'legacy-extracted'),script=path.join(app.config.root,'backend/scripts/archive.py');
    await exec(python,[script,'mod-extract',source,folder,'1048576']);assert.ok(fs.existsSync(path.join(folder,'modinfo.lua')));assert.ok(fs.existsSync(path.join(folder,'scripts/data.lua')));
    const bad=await archive(app,'bad-legacy.bin',{'..\\escape':'oops','modinfo.lua':'name="bad"'});
    await assert.rejects(()=>exec(python,[script,'mod-extract',bad,path.join(app.data,'bad-extracted'),'1048576']));
    const missing=await archive(app,'missing-legacy.bin',{'readme.txt':'no lua'});
    await assert.rejects(()=>exec(python,[script,'mod-extract',missing,path.join(app.data,'missing-extracted'),'1048576']));
  }finally{await app.cleanup();}
});

function fixture() {
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-test-'));
  const app=createPanel({data,game:path.join(data,'dst'),steam:path.join(data,'steamcmd'),python,adminToken:'test-administrator-token-with-length',clusterToken:'test-cluster-token',publicHost:'example.invalid',translationProvider:'off'});
  app.runtime.sessions=async()=>new Set();
  return {...app,data,async cleanup(){await new Promise(resolve=>{if(app.server.listening)app.server.close(resolve);else resolve();});app.close();fs.rmSync(data,{recursive:true,force:true});}};
}
const draft=()=>({name:'朋友联机',password:'hello',maxPlayers:12,mode:'endless',pvp:false,pause:true,vote:true,worldCount:2,
  worlds:[{directory:'Master',type:'forest',port:11001,levelData:presets.endless.master},{directory:'Caves',type:'caves',port:11002,levelData:presets.endless.caves}],
  mods:[{id:'378160973',name:'Positions',enabled:true,config:{show:true,quote:'";os.execute("oops")'}}],automation:{backupTime:'06:00',autoBackup:true,startType:'64-bit'}});

test('all world presets parse as static data; dynamic Lua rejected and values escaped',()=>{
  for(const preset of Object.values(presets))for(const source of Object.values(preset))assert.ok(levelData(source).overrides);
  assert.throws(()=>levelData('os.execute("bad"); return {overrides={}}'));
  assert.throws(()=>levelData('return {overrides={foo=os.execute("bad")}}'));
  assert.match(lua({enabled:true,text:'x\n"\\'}),/\\010/);
  const fields=modFields('configuration_options={{name="on",label="开关",default=true,options={{description="开",data=true},{description="关",data=false}}}}');
  assert.equal(fields[0].options[1].data,false);
  assert.throws(()=>modFields('configuration_options=loadstring("evil")()'));
});
test('room save writes independent world files and rejects invalid/injected/colliding input',async()=>{
  const app=fixture();try{
    const input=draft(),result=await app.rooms.save('0',input);assert.equal(result.saved,true);
    const cluster=app.store.cluster('0');
    assert.match(fs.readFileSync(path.join(cluster,'cluster.ini'),'utf8'),/cluster_name = 朋友联机/);
    assert.match(fs.readFileSync(path.join(cluster,'Master/server.ini'),'utf8'),/is_master = true/);
    assert.match(fs.readFileSync(path.join(cluster,'Caves/server.ini'),'utf8'),/is_master = false/);
    assert.equal(fs.readFileSync(path.join(cluster,'Caves/leveldataoverride.lua'),'utf8'),presets.endless.caves);
    assert.ok(!('_clusterKey' in result.config));
    for(const change of [v=>v.name='x\n[SHARD]',v=>v.worlds[0].directory='../bad',v=>v.worlds[1].port=v.worlds[0].port,v=>v.pvp='true',v=>v.worlds[0].levelData='os.execute("bad")']){
      const invalid=draft();change(invalid);await assert.rejects(()=>app.rooms.save('0',invalid));
    }
    await assert.rejects(()=>app.rooms.save('1',draft()),/已被其他房间使用/);
    const firstPorts=app.store.getRoom('0')._ports,second=draft();second.worlds.forEach((world,index)=>world.port=12001+index);
    await app.rooms.save('1',second);assert.ok(app.store.getRoom('1')._ports.every(port=>!firstPorts.includes(port)));
    const fewer=draft();fewer.worldCount=1;await app.rooms.save('0',fewer);assert.equal(app.store.getRoom('0').worlds.length,1);
  }finally{await app.cleanup();}
});
test('symlinks and path traversal cannot leave controlled directories',async()=>{
  const app=fixture();try{
    assert.throws(()=>inside(app.data,'../../outside'));
    const link=path.join(app.data,'link');
    try{fs.symlinkSync(os.tmpdir(),link,process.platform==='win32'?'junction':'dir');assert.throws(()=>inside(app.data,'link/private'));}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;}
  }finally{await app.cleanup();}
});

test('hidden ports follow DMP defaults, remain attached to each world and avoid other rooms and direct ports',async()=>{
  const app=fixture();try{
    await app.rooms.save('0',draft());assert.deepEqual(app.store.getRoom('0')._ports,[21001,31001,41001,31002,41002]);
    const edited=draft();edited.name='Renamed';edited.worlds.reverse();await app.rooms.save('0',edited);
    assert.deepEqual(app.store.getRoom('0')._ports,[21001,31002,41002,31001,41001]);
    const other=draft();other.worlds[0].port=31003;other.worlds[1].port=12002;await app.rooms.save('1',other);
    assert.deepEqual(app.store.getRoom('1')._ports,[21002,31004,41003,31005,41004]);
    assert.ok(!('_ports' in app.rooms.public(app.store.getRoom('0'))));
    const unchanged=app.store.getRoom('1')._ports;await app.rooms.save('1',other);assert.deepEqual(app.store.getRoom('1')._ports,unchanged);
  }finally{await app.cleanup();}
});
test('snapshot rollback coordinates worlds, creates a full safety backup and preserves older files',async()=>{
  const app=fixture();try{
    await app.rooms.save('0',draft());
    for(const directory of ['Master','Caves']){
      const session=path.join(app.store.cluster('0'),directory,'save/session/ABCDEF0123456789');fs.mkdirSync(session,{recursive:true});
      for(const [name,cycles]of [['0000000001',9],['0000000002',10]]){fs.writeFileSync(path.join(session,name),'binary-world-'+name);fs.writeFileSync(path.join(session,name+'.meta'),`return {cycles=${cycles}}`);}
      const player=path.join(session,'player-id');fs.mkdirSync(player);fs.writeFileSync(path.join(player,'0000000002'),'player-new');
    }
    const rows=app.saves.snapshots('0');assert.equal(rows.length,4);assert.ok(rows.every(row=>row.day!==null));
    const target=rows.find(row=>row.worldID==='Master'&&row.day===10);
    const result=await app.saves.restoreSnapshot('0',target.id,target.worldID);assert.equal(result.restored,true);
    for(const directory of ['Master','Caves']){
      const session=path.join(app.store.cluster('0'),directory,'save/session/ABCDEF0123456789');assert.ok(fs.existsSync(path.join(session,'0000000001')));assert.ok(!fs.existsSync(path.join(session,'0000000002')));assert.ok(!fs.existsSync(path.join(session,'player-id/0000000002')));
    }
    assert.equal(app.saves.list('0').rows.length,1);assert.equal(app.saves.list('0').rows[0].id,result.backupID);
  }finally{await app.cleanup();}
});
async function archive(app,filename,entries,mode='zip'){
  const target=path.join(app.data,filename);
  const script=mode==='zip'?'import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); [z.writestr(k,v) for k,v in json.loads(sys.argv[2]).items()];z.close()':'import sys,json,tarfile,io; t=tarfile.open(sys.argv[1],"w:gz"); [(lambda i,b:(setattr(i,"size",len(b)),t.addfile(i,io.BytesIO(b))))(tarfile.TarInfo(k),v.encode()) for k,v in json.loads(sys.argv[2]).items()];t.close()';
  await exec(python,['-c',script,target,JSON.stringify(entries)]);return target;
}
test('upload checks actual archive structure and does not overwrite active saves',async()=>{
  const app=fixture();try{
    await app.rooms.save('0',draft());const entries={'Cluster/cluster.ini':'[NETWORK]\ncluster_name=Uploaded\n','Cluster/Master/server.ini':'[NETWORK]\nserver_port=11001\n','Cluster/Master/save/session/ABCDEF0123456789/0000000001':'worlddata'};
    for(const mode of ['zip','tgz']){
      const file=await archive(app,'upload.'+mode,entries,mode);const result=await app.saves.upload('0',file,'Uploaded');assert.equal(result.uploaded,true);
    }
    assert.equal(app.saves.list('0').rows.length,2);assert.match(fs.readFileSync(path.join(app.store.cluster('0'),'cluster.ini'),'utf8'),/朋友联机/);
    const bad=await archive(app,'bad.zip',{'../../escaped':'bad',...entries});await assert.rejects(()=>app.saves.upload('0',bad,'Bad'),/路径/);
    const empty=await archive(app,'empty.zip',{'cluster.ini':'[NETWORK]\ncluster_name=empty\n'});await assert.rejects(()=>app.saves.upload('0',empty,'Empty'),/server.ini/);
  }finally{await app.cleanup();}
});

test('saved world configuration accepts only the known uncompressed Klei header and static Lua',()=>{
  const source='return {id="DST_CAVE",location="cave",overrides={location="caves",season_start="default"}}';
  for(const input of [source,'KLEI     1 '+source,'\uFEFFKLEI     1 '+source])assert.equal(savedLevelSource(input),source);
  for(const input of ['KLEI     2 '+source,'KLEI     1 os.execute("bad"); '+source,'KLEI     1 return {overrides={foo=os.execute("bad")}}','garbage '+source,''])assert.throws(()=>savedLevelSource(input));
});

test('full restore retains Klei-header caves, orders the master first and replaces settings, saves and mods in every shard',async()=>{
  const app=fixture();try{
    await app.rooms.save('0',draft());
    const root=app.store.cluster('0'),old=path.join(root,'Master/save/old-world');fs.mkdirSync(path.dirname(old),{recursive:true});fs.writeFileSync(old,'old world');
    const id='123456789',folder=path.join(app.config.game,'mods/workshop-'+id);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'modinfo.lua'),'name="Imported mod"');
    const cave='return {id="DST_CAVE",location="cave",overrides={location="caves",weather="never"}}';
    const overrides='return { ["workshop-'+id+'"]={enabled=true,configuration_options={flag=false}} }';
    const entries={'Cluster/cluster.ini':'[NETWORK]\ncluster_name=Imported room\ncluster_password=new\n[GAMEPLAY]\ngame_mode=survival\nmax_players=8\npvp=true\n[SHARD]\nmaster_port=21500\ncluster_key=imported-cluster-key\n',
      'Cluster/ZSurface/server.ini':'[NETWORK]\nserver_port=10998\n[SHARD]\nis_master=true\nid=101\n[STEAM]\nmaster_server_port=31501\nauthentication_port=41501\n',
      'Cluster/ZSurface/leveldataoverride.lua':'return {location="forest",overrides={season_start="autumn"}}',
      'Cluster/ZSurface/modoverrides.lua':overrides,
      'Cluster/ZSurface/save/session/ABCDEF0123456789/0000000201':'imported surface bytes',
      'Cluster/AUnderworld/server.ini':'[NETWORK]\nserver_port=10999\n[SHARD]\nis_master=false\nid=102\n[STEAM]\nmaster_server_port=31502\nauthentication_port=41502\n',
      'Cluster/AUnderworld/leveldataoverride.lua':'KLEI     1 '+cave,
      'Cluster/AUnderworld/save/session/0123456789ABCDEF/0000000201':'imported cave bytes'};
    let running=true,started=[];
    app.runtime.status=async()=>app.store.getRoom('0').worlds.map(world=>({...world,running}));
    app.runtime.stop=async()=>{running=false;};app.runtime.start=async()=>{started=app.store.getRoom('0').worlds.map(world=>world.directory);running=true;};
    const file=await archive(app,'klei-caves.zip',entries),uploaded=await app.saves.upload('0',file,'Klei caves');
    const result=await app.saves.restore('0',uploaded.save.id),room=app.store.getRoom('0');
    assert.equal(result.restored,true);assert.equal(room.worldCount,2);assert.deepEqual(started,['ZSurface','AUnderworld']);
    assert.deepEqual(room.worlds.map(world=>[world.directory,world.type,world.port]),[['ZSurface','forest',10998],['AUnderworld','caves',10999]]);
    assert.deepEqual(room._ports,[21500,31501,41501,31502,41502]);assert.equal(room._clusterKey,'imported-cluster-key');
    assert.equal(room.name,'Imported room');assert.equal(room.password,'new');assert.equal(room.mode,'survival');assert.equal(room.maxPlayers,8);assert.equal(room.pvp,true);
    assert.deepEqual(room.mods.map(mod=>mod.id),[id]);assert.equal(room.mods[0].config.flag,false);
    assert.equal(fs.readFileSync(path.join(root,'AUnderworld/leveldataoverride.lua'),'utf8'),cave);
    for(const world of room.worlds){assert.ok(levelData(world.levelData));const mods=fs.readFileSync(path.join(root,world.directory,'modoverrides.lua'),'utf8');assert.match(mods,/workshop-123456789/);assert.doesNotMatch(mods,/workshop-378160973/);}
    assert.equal(fs.readFileSync(path.join(root,'AUnderworld/save/session/0123456789ABCDEF/0000000201'),'utf8'),'imported cave bytes');assert.ok(!fs.existsSync(path.join(root,'Master')));
    assert.match(fs.readFileSync(path.join(root,'AUnderworld/server.ini'),'utf8'),/id=102/);
    assert.ok(app.saves.list('0').rows.some(row=>row.id===result.backupID));
  }finally{await app.cleanup();}
});

test('an unreadable shard fails the complete restore without silently losing caves or overwriting the current room',async()=>{
  const app=fixture();try{
    await app.rooms.save('0',draft());const previous=app.store.getRoom('0'),root=app.store.cluster('0');
    const file=await archive(app,'invalid-caves.zip',{'cluster.ini':'[NETWORK]\ncluster_name=Bad import\n',
      'Master/server.ini':'[NETWORK]\nserver_port=11001\n', 'Master/leveldataoverride.lua':presets.endless.master,
      'Master/save/session/ABCDEF0123456789/0000000001':'new world',
      'Caves/server.ini':'[NETWORK]\nserver_port=11002\n', 'Caves/leveldataoverride.lua':'KLEI     1 return {overrides={weather=unsafe()}}'});
    const uploaded=await app.saves.upload('0',file,'Broken caves');
    await assert.rejects(()=>app.saves.restore('0',uploaded.save.id),/世界 Caves 配置读取失败/);
    assert.deepEqual(app.store.getRoom('0'),previous);assert.equal(fs.readFileSync(path.join(root,'Caves/leveldataoverride.lua'),'utf8'),presets.endless.caves);
    assert.match(fs.readFileSync(path.join(root,'cluster.ini'),'utf8'),/朋友联机/);assert.ok(!fs.existsSync(path.join(root,'Master/save/session')));
    assert.ok(!app.saves.list('0').rows.some(row=>row.source==='backup')); // Validation fails before stopping or backing up the live room.
  }finally{await app.cleanup();}
});
test('HTTP authentication, CSRF guard, static injection, persistence and upload contract',async()=>{
  const app=fixture();let base;
  try{
    app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base='http://127.0.0.1:'+app.server.address().port;
    let response=await fetch(base+'/api/rooms/0');assert.equal(response.status,401);
    response=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.store.adminToken})});assert.equal(response.status,200);
    const cookie=response.headers.get('set-cookie').split(';')[0],headers={'Content-Type':'application/json',Cookie:cookie};
    response=await fetch(base+'/api/rooms/0',{method:'PUT',headers,body:JSON.stringify(draft())});assert.equal(response.status,200);
    response=await fetch(base+'/api/rooms/0',{headers:{Cookie:cookie}});assert.equal((await response.json()).data.name,'朋友联机');
    response=await fetch(base+'/',{headers:{Cookie:cookie}});assert.match(await response.text(),/<script nonce="[^"]+" src="\/backend-client.js"><\/script>/);
    response=await fetch(base+'/backend/src/server.mjs',{headers:{Cookie:cookie}});assert.equal(response.status,404);
    response=await fetch(base+'/api/rooms/0',{method:'PUT',headers:{...headers,Origin:'https://attacker.invalid'},body:JSON.stringify(draft())});assert.equal(response.status,403);
    response=await fetch(base+'/api/rooms/0/status',{headers:{Cookie:cookie}});const status=(await response.json()).data;assert.equal(status.players,0);assert.match(status.directCode,/c_connect/);assert.equal(status.worlds.length,2);
    app.lobby.check=async id=>({listed:true,roomID:id,message:'已在科雷服务器列表找到当前房间'});
    response=await fetch(base+'/api/rooms/0/control',{method:'POST',headers,body:JSON.stringify({action:'check'})});assert.equal(response.status,200);assert.equal((await response.json()).data.listed,true);
    response=await fetch(base+'/api/rooms/0/saves/upload?filename=bad.zip',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/octet-stream'},body:'not-an-archive'});assert.equal(response.status,400);
    const archiveFile=await archive(app,'http-upload.zip',{'cluster.ini':'[NETWORK]\ncluster_name=upload\n','Master/server.ini':'[NETWORK]\nserver_port=11001\n','Master/save/session/ABCDEF0123456789/0000000001':'world'});
    response=await fetch(base+'/api/rooms/0/saves/upload?filename=room.zip&name=HTTP-save',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/octet-stream'},body:fs.readFileSync(archiveFile)});
    assert.equal(response.status,200);assert.equal((await response.json()).data.uploaded,true);assert.equal(app.saves.list('0').rows[0].name,'HTTP-save');
    response=await fetch(base+'/api/rooms/0/logs',{headers:{Cookie:cookie}});assert.ok((await response.json()).data.rows.some(row=>row.type==='system'));
  }finally{await app.cleanup();}
});
test('tasks record real failures and scheduler runs once for each day',async()=>{
  const app=fixture();try{
    await app.rooms.save('0',draft());let calls=0;const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:app.config.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts().map(p=>[p.type,p.value]));
    const room=app.store.getRoom('0');room.automation.backupTime=parts.hour+':'+parts.minute;app.store.putRoom('0',room);app.saves.backup=async()=>{calls++;return {backedUp:true};};
    await app.saves.tick();await new Promise(resolve=>setTimeout(resolve,30));await app.saves.tick();assert.equal(calls,1);
    const result=app.store.task('failure','0',async()=>{throw Error('expected failure');});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(app.store.getTask(result.taskID).state,'failed');assert.equal(app.store.getTask(result.taskID).error,'expected failure');
  }finally{await app.cleanup();}
});
test('saved room and administrator identity survive service restart',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feather-persist-'));
  const options={data:directory,game:path.join(directory,'dst'),python,clusterToken:'test-token'};
  let app=createPanel(options);app.runtime.sessions=async()=>new Set();
  try{
    const token=app.store.adminToken;await app.rooms.save('0',draft());app.close();app=createPanel(options);
    assert.equal(app.store.adminToken,token);assert.equal(app.store.getRoom('0').name,'朋友联机');assert.equal(app.store.getRoom('0').password,'hello');
  }finally{app.close();fs.rmSync(directory,{recursive:true,force:true});}
});
test('Linux screen starts and safely stops every configured world',{skip:process.platform!=='linux'},async()=>{
  const app=fixture();
  try{
    await app.rooms.save('screencheck',draft());
    const mod=path.join(app.config.game,'mods/workshop-378160973');fs.mkdirSync(mod,{recursive:true});fs.writeFileSync(path.join(mod,'modinfo.lua'),'name="Positions"');
    app.runtime.sessions=Runtime.prototype.sessions.bind(app.runtime);
    const executable=path.join(app.config.game,'bin64/dontstarve_dedicated_server_nullrenderer_x64');
    fs.mkdirSync(path.dirname(executable),{recursive:true});
    fs.writeFileSync(executable,'#!/bin/sh\nwhile IFS= read -r line; do\ncase "$line" in c_shutdown*) exit 0;; esac\ndone\n',{mode:0o755});
    await app.runtime.start('screencheck');
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal((await app.runtime.status('screencheck')).filter(world=>world.running).length,2);
    await app.runtime.stop('screencheck',['Caves']);
    let states=await app.runtime.status('screencheck');assert.equal(states.find(world=>world.directory==='Master').running,true);assert.equal(states.find(world=>world.directory==='Caves').running,false);
    await app.runtime.start('screencheck',['Caves']);await new Promise(resolve=>setTimeout(resolve,150));
    await app.runtime.stop('screencheck',['Master']);
    states=await app.runtime.status('screencheck');assert.equal(states.find(world=>world.directory==='Caves').running,true);assert.equal(states.find(world=>world.directory==='Master').running,false);
    await assert.rejects(()=>app.runtime.stop('screencheck',['Unknown']),/有效的世界/);
    await assert.rejects(()=>app.runtime.start('screencheck',[]),/有效的世界/);
    await app.runtime.stop('screencheck');
    assert.equal((await app.runtime.status('screencheck')).filter(world=>world.running).length,0);
  }finally{
    for(const shard of ['Master','Caves'])try{await exec('screen',['-S',app.runtime.session('screencheck',shard),'-X','quit']);}catch{}
    await app.cleanup();
  }
});

test('telemetry merges worlds, distinguishes missing data and uses the game map renderer',async()=>{
  const app=fixture();try{
    await app.rooms.save('0',draft());
    const session=path.join(app.store.cluster('0'),'Master/save/session/ABCDEF0123456789');fs.mkdirSync(session,{recursive:true});
    fs.writeFileSync(path.join(session,'0000000009.meta'),'return {clock={cycles=12}}\0');
    assert.equal((await app.runtime.overview('0')).day,13);
    app.runtime.sessions=async()=>new Set(['Feather_0_Master','Feather_0_Caves']);
    app.runtime.telemetry.read=async(id,world,map)=>{
      if(map)return {width:3,height:1,names:{7:'FOREST',8:'SAVANNA'},rows:[{kind:'row',y:0,runs:[7,2,8,1]}],state:{cycles:13}};
      return {cycles:13,season:'autumn',players:[{userid:world.directory,name:'<untrusted>',prefab:'wilson'}]};
    };
    const result=await app.runtime.overview('0');assert.equal(result.players,2);assert.equal(result.day,14);assert.deepEqual(result.playerList.map(p=>p.world),['Master','Caves']);
    const local=app.runtime.telemetry.read;
    app.runtime.telemetry.read=async(id,world,map)=>map?local(id,world,map):{cycles:13,players:[{userid:'same-user',name:'Migrating',localPlayer:world.directory==='Master'}]};
    const merged=await app.runtime.overview('0');assert.equal(merged.players,1);assert.equal(merged.playerList[0].world,'Master');app.runtime.telemetry.read=local;
    app.runtime.mapRenderer.render=async data=>({image:'data:image/png;base64,TEST',legend:[{name:'FOREST'},{name:'SAVANNA'}],renderer:'klei-textures-v1'});
    const map=await app.runtime.mapPreview('0','Caves');assert.equal(map.width,3);assert.ok(!('synthetic' in map));assert.match(map.image,/^data:image\/png;base64,/);assert.equal(map.legend.length,2);assert.ok(!map.svg);
    app.runtime.telemetry.read=async()=>{throw Error('probe timeout');};
    const missing=await app.runtime.overview('0');assert.equal(missing.players,null);assert.equal(missing.telemetry.complete,false);assert.equal(missing.telemetry.errors.length,2);
  }finally{await app.cleanup();}
});
test('workshop retries transient failures, rejects foreign app data and falls back to explicit cache',async()=>{
  const app=fixture();try{
    let calls=0;app.mods.fetch=async()=>{if(++calls===1)throw Error('network');return {ok:true,json:async()=>({response:{publishedfiledetails:[{result:1,publishedfileid:'378160973',consumer_app_id:322330,title:'Global Positions'},{result:1,publishedfileid:'999999999',consumer_app_id:440,title:'Wrong game'}]}})};};
    const result=await app.mods.details(['378160973','999999999']);assert.equal(calls,2);assert.equal(result.rows.length,1);assert.equal(result.source,'steam');
    app.mods.fetch=async()=>{throw Error('network');};const cached=await app.mods.details(['378160973']);assert.equal(cached.source,'cache');assert.match(cached.warning,/缓存/);
    await assert.rejects(()=>app.mods.details(['123456789']),error=>error.status===504);
    app.mods.config.steamKey='';const search=await app.mods.search({searchText:'Positions'});assert.equal(search.source,'cache');assert.equal(search.rows.length,1);
  }finally{await app.cleanup();}
});
test('telemetry accepts only its correlated JSON result and shares concurrent collection',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feather-probe-'));fs.mkdirSync(path.join(directory,'Master'));
  let calls=0;
  const telemetry=new Telemetry({store:{cluster:()=>directory},command:async(id,command)=>{
    calls++;const token=command.match(/FP_[a-f0-9]{20}/)[0];
    fs.writeFileSync(path.join(directory,'Master/server_log.txt'),[
      `RemoteCommandInput: ${command}`,
      'FP_00000000000000000000\t{"kind":"state","players":[{"name":"old"}]}',
      `[00:01:00]: ${token}\t{"kind":"state","players":[],"cycles":7}`,
      `[00:01:00]: ${token}\t{"kind":"done"}`
    ].join('\n'));
  }});
  try{
    const [first,second]=await Promise.all([telemetry.read('0',{directory:'Master'}),telemetry.read('0',{directory:'Master'})]);
    assert.equal(calls,1);assert.equal(first.cycles,7);assert.equal(second.players.length,0);
    await telemetry.read('0',{directory:'Master'});assert.equal(calls,1);
    telemetry.invalidate('0','Master');await telemetry.read('0',{directory:'Master'});assert.equal(calls,2);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('workshop default supports recommendations, detailed name results, paging and cached outages',async()=>{
  assert.match(defaultSteamApiKey(),/^[a-f0-9]{32}$/);
  assert.equal(configuration().steamKey,process.env.FEATHER_STEAM_API_KEY||defaultSteamApiKey());
  const app=fixture();try{
    const requests=[];
    app.mods.fetch=async url=>{
      requests.push(new URL(url));
      return {ok:true,json:async()=>({response:{total:80,publishedfiledetails:[{publishedfileid:'378160973',title:'Global Positions',preview_url:'https://images.steamusercontent.com/test',subscriptions:100,consumer_app_id:322330},{publishedfileid:'999999999',title:'Wrong game',consumer_app_id:440}]}})};
    };
    const recommended=await app.mods.search({searchText:''});
    assert.equal(recommended.total,80);assert.equal(recommended.rows.length,1);assert.equal(recommended.rows[0].name,'Global Positions');assert.equal(recommended.rows[0].subscriptions,100);
    assert.equal(requests[0].searchParams.get('return_details'),'true');assert.equal(requests[0].searchParams.has('search_text'),false);assert.equal(requests[0].searchParams.get('match_all_tags'),'false');
    const named=await app.mods.search({page:2,pageSize:36,searchText:'定位'});assert.equal(named.rows.length,1);assert.equal(requests[1].searchParams.get('search_text'),'定位');assert.equal(requests[1].searchParams.get('page'),'2');
    const cached=await app.mods.search({page:2,pageSize:36,searchText:'定位'});assert.equal(cached.source,'steam-cache');assert.equal(requests.length,2);
    const searchCache=path.join(app.data,'workshop-search');
    for(const file of fs.readdirSync(searchCache)){const target=path.join(searchCache,file),entry=JSON.parse(fs.readFileSync(target));entry.fetchedAt=0;fs.writeFileSync(target,JSON.stringify(entry));}
    app.mods.fetch=async()=>{throw Error('offline');};const stale=await app.mods.search({page:2,pageSize:36,searchText:'定位'});assert.match(stale.warning,/上次/);assert.equal(stale.total,80);
    app.mods.fetch=async()=>({ok:true,json:async()=>({response:{total:0}})});assert.equal((await app.mods.search({searchText:'empty'})).rows.length,0);
    app.mods.fetch=async()=>({ok:true,json:async()=>({response:{result:15,total:0}})});await assert.rejects(()=>app.mods.search({searchText:'denied'}),error=>error.status===502);
  }finally{await app.cleanup();}
});

test('expired workshop search cache returns immediately and coalesces background refresh',async()=>{
  const app=fixture();try{
    let calls=0,release;
    app.mods.fetch=async()=>{calls++;if(calls===1)return {ok:true,json:async()=>({response:{total:1,publishedfiledetails:[{publishedfileid:'378160973',title:'Fresh Positions',consumer_app_id:322330}]}})};await new Promise(resolve=>{release=resolve;});return {ok:true,json:async()=>({response:{total:1,publishedfiledetails:[{publishedfileid:'378160973',title:'Fresh Positions',consumer_app_id:322330}]}})};};
    const first=await app.mods.search({searchText:'Positions'});
    assert.equal(first.rows[0].name,'Fresh Positions');
    const cacheDir=path.join(app.data,'workshop-search'),cacheFile=fs.readdirSync(cacheDir)[0],cachePath=path.join(cacheDir,cacheFile),entry=JSON.parse(fs.readFileSync(cachePath));entry.fetchedAt=0;fs.writeFileSync(cachePath,JSON.stringify(entry));
    const stale=await app.mods.search({searchText:'Positions'});assert.equal(stale.source,'steam-cache');assert.match(stale.warning,/后台刷新/);
    const again=await app.mods.search({searchText:'Positions'});assert.equal(again.source,'steam-cache');assert.equal(calls,2);
    release();await new Promise(resolve=>setImmediate(resolve));
  }finally{await app.cleanup();}
});

test('deleting an installed mod removes stopped-room references before deleting shared files',async()=>{
  const app=fixture();try{
    const id='378160973';await app.rooms.save('0',draft());
    const folder=path.join(app.config.game,'mods/workshop-'+id);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'modinfo.lua'),'name="Positions"');
    app.runtime.status=async()=>[{running:false},{running:false}];
    const result=await app.mods.remove('0',id);assert.deepEqual(result,{deleted:true,id});
    assert.equal(fs.existsSync(folder),false);
    const room=app.store.getRoom('0');assert.equal(room.mods.some(mod=>mod.id===id),false);
    for(const world of room.worlds)assert.doesNotMatch(fs.readFileSync(path.join(app.store.cluster('0'),world.directory,'modoverrides.lua'),'utf8'),new RegExp('workshop-'+id));
  }finally{await app.cleanup();}
});
