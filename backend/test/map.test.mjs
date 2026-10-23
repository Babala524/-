import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Telemetry} from '../src/telemetry.mjs';
import {Runtime} from '../src/runtime.mjs';
import {savedMapFields} from '../src/save-map.mjs';

function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feather-map-'));
  const session=path.join(directory,'Master/save/session/ABCDEF0123456789');fs.mkdirSync(session,{recursive:true});
  const payload=Buffer.alloc(8+6*2+1);payload.write('VRSN');payload.writeUInt16BE(1,4);
  [7,6,257,457,1,260].forEach((tile,i)=>payload.writeUInt16BE(tile,8+i*2));
  const source=`local tablefunctions={}\ntablefunctions["map_fn"] = function()\nreturn {tiles="${payload.toString('base64')}",width=3,height=2,world_tile_map={FOREST=7,GRASS=6,MONKEY_GROUND=257,OCEAN_COASTAL=201,IMPASSABLE=1,VENT=260},prefab="forest"}\nend\ntablefunctions["ents_walrus_camp_fn"] = function()\nreturn {{id=1,x=-4,data={children={5},nested={x=999,z=888}},z=4},{id=2,x=4,z=-4}}\nend\n`;
  fs.writeFileSync(path.join(session,'0000000001'),source);fs.writeFileSync(path.join(session,'0000000001.meta'),'return {clock={cycles=12}}');
  return {directory,session,source,cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})};
}

test('saved maps skip VRSN header, preserve uint16 tile IDs and read names regardless of the following field',async()=>{
  const f=fixture();let calls=0;const telemetry=new Telemetry({store:{cluster:()=>f.directory},command:async()=>{calls++;throw Error('console unavailable');}});
  try{
    const data=await telemetry.read('0',{directory:'Master'},true);
    assert.equal(calls,0);assert.deepEqual(data.tiles,[7,6,257,201,1,260]);assert.equal(data.names[257],'MONKEY_GROUND');
    assert.deepEqual(data.creatures,{'杀人蜂巢':0,'海象营地':2});assert.deepEqual(data.markers,[{kind:'海象营地',x:-4,z:4},{kind:'海象营地',x:4,z:-4}]);assert.ok(data.savedAt);
  }finally{f.cleanup();}
});

test('wasphive and legacy aliases are counted, including referenced data; ordinary and queen hives are excluded',async()=>{
  const f=fixture(),telemetry=new Telemetry({store:{cluster:()=>f.directory}});
  try{
    fs.appendFileSync(path.join(f.session,'0000000001'),[
      'tablefunctions["ents_wasphive_fn"] = function()\nreturn {{x=0,z=0,data=tablefunctions["shared_fn"]()},{x=4,z=8},{id=3,data=unknown_reference}}\nend\n',
      'tablefunctions["ents_killerbeehive_fn"] = function()\nreturn {{x=8,z=12,data={children=other_reference}}}\nend\n',
      'tablefunctions["ents_beehive_fn"] = function()\nreturn {{x=20,z=20}}\nend\n',
      'tablefunctions["ents_beequeenhive_fn"] = function()\nreturn {{x=30,z=30}}\nend\n'
    ].join(''));
    const data=await telemetry.read('0',{directory:'Master'},true);
    assert.equal(data.creatures['杀人蜂巢'],4);assert.equal(data.creatures['海象营地'],2);
    assert.equal(data.markers.filter(m=>m.kind==='杀人蜂巢').length,3);
    assert.equal(data.entities.filter(e=>['wasphive','killerbeehive'].includes(e.prefab)).length,3);
    assert.ok(data.entities.some(e=>e.prefab==='beehive')); // Still drawn on the map, not included in target totals.
  }finally{f.cleanup();}
});

test('invalid target entity data reports unavailable instead of a misleading zero',async()=>{
  const f=fixture(),telemetry=new Telemetry({store:{cluster:()=>f.directory}});
  try{
    fs.appendFileSync(path.join(f.session,'0000000001'),'tablefunctions["ents_wasphive_fn"] = function()\nreturn load_dynamic_data()\nend\n');
    const data=await telemetry.read('0',{directory:'Master'},true);assert.equal(data.creatures['杀人蜂巢'],null);assert.equal(data.creatures['海象营地'],2);
  }finally{f.cleanup();}
});

test('live collection asks for actual wasphive entities and returns their count and markers',async()=>{
  const f=fixture();const runtime={store:{cluster:()=>f.directory},command:async(id,command)=>{
    assert.match(command,/wasphive="杀人蜂巢"/);assert.match(command,/killerbeehive="杀人蜂巢"/);
    const token=command.match(/FP_[a-f0-9]{20}/)[0];fs.writeFileSync(path.join(f.directory,'Master/server_log.txt'),token+'\t'+JSON.stringify({kind:'state',players:[],creatures:{'杀人蜂巢':4,'海象营地':2},points:[{kind:'杀人蜂巢',x:0,z:0}]})+'\n'+token+'\t'+JSON.stringify({kind:'done'}));
  }};
  try{const data=await new Telemetry(runtime).collect('0',{directory:'Master'},false);assert.equal(data.creatures['杀人蜂巢'],4);assert.equal(data.points[0].kind,'杀人蜂巢');}finally{f.cleanup();}
});

test('map requests use saved data even when the console is hung or the world is stopped; refresh reads new snapshots',async()=>{
  const f=fixture();let calls=0;const runtime=new Runtime({config:{},cluster:()=>f.directory,getRoom:()=>({mods:[]})});runtime.command=async()=>{calls++;return new Promise(()=>{});};
  runtime.status=async()=>[{directory:'Master',type:'forest',running:true}];
  runtime.mapRenderer.render=async data=>({renderer:'klei-textures-v1',image:'data:image/png;base64,'+data.names[7],legend:Object.values(data.names).map(name=>({name}))});
  try{
    const running=await runtime.mapPreview('0','Master');assert.equal(calls,0);assert.equal(running.day,13);assert.equal(running.creatures['海象营地'],2);assert.equal(running.creaturesSource,'save');assert.equal(running.legend.length,6);assert.equal(running.worlds.length,1);assert.equal(running.renderer,'klei-textures-v1');
    runtime.status=async()=>[{directory:'Master',type:'forest',running:false}];assert.equal((await runtime.mapPreview('0','Master')).image,running.image);
    fs.writeFileSync(path.join(f.session,'0000000002'),f.source.replace('FOREST=7','DECIDUOUS=7'));runtime.telemetry.invalidate('0','Master');assert.ok((await runtime.mapPreview('0','Master')).legend.some(row=>row.name==='DECIDUOUS'));
    runtime.mapRenderer.render=async()=>{throw Error('缺少原版资源');};await assert.rejects(runtime.mapPreview('0','Master'),/缺少原版资源/);
  }finally{f.cleanup();}
});

test('an incomplete latest save falls back to a valid snapshot; missing maps explain the problem',async()=>{
  const f=fixture();const telemetry=new Telemetry({store:{cluster:()=>f.directory}});
  try{
    fs.writeFileSync(path.join(f.session,'0000000002'),f.source.replace('height=2','height=200'));
    assert.equal((await telemetry.read('0',{directory:'Master'},true)).height,2);
    await assert.rejects(telemetry.read('0',{directory:'Caves'},true),error=>error.status===409&&/存档/.test(error.message));
  }finally{f.cleanup();}
});

test('Hamlet interior dimensions and nested tile data cannot replace the real map fields',async()=>{
  const f=fixture(),telemetry=new Telemetry({store:{cluster:()=>f.directory}});
  try{
    const poisoned='tablefunctions["ents_interior_fn"] = function()\nreturn {{width=24,height=5,tiles="VlJTTgABAAAA",world_tile_map={WRONG=7},roads={{x=999,z=999}}}}\nend\n';
    const source=poisoned+f.source.replace('width=3,height=2', 'interiors={{width=24,height=5,tiles="wrong",world_tile_map={WRONG=7},roads={{x=888,z=888}}}},width=3,height=2,roads={{x=4,z=8}}');
    fs.writeFileSync(path.join(f.session,'0000000001'),source);
    const data=await telemetry.read('0',{directory:'Master'},true);
    assert.equal(data.width,3);assert.equal(data.height,2);assert.equal(data.names[7],'FOREST');assert.equal(data.tiles.length,6);assert.deepEqual(data.roads.map(r=>({...r})),[{x:4,z:8}]);
  }finally{f.cleanup();}
});

test('saved map field scan skips escaped strings, long strings, comments and nested references',()=>{
  const source=`tablefunctions["map_fn"] = function()\nreturn {
    -- width=24,height=5
    ["tiles"]="YWJjZA==",note="width=888,\\\"height=8}\\\"",
    nested={width=24,height=5,text=[=[},width=999,[[]]=]},
    --[=[ },height=999 ]=]
    width=645; height=645,roads={{fn=tablefunctions["roads_fn"](),nested={width=4}}},world_tile_map={FOREST=7}
  }\nend`;
  const result=savedMapFields(source);
  assert.equal(result.width,'645');assert.equal(result.height,'645');assert.equal(result.tiles,'"YWJjZA=="');
  assert.equal(result.world_tile_map,'{FOREST=7}');assert.match(result.roads,/roads_fn/);
  assert.equal(savedMapFields(source.slice(0,-7)),null);
  assert.equal(savedMapFields('return {interior={width=24,height=5},map={width=645,height=645,tiles="YWJjZA=="}}').width,'645');
});

test('saved active mods take priority over room edits and keep shard configuration',async()=>{
 const f=fixture(),runtime=new Runtime({config:{},cluster:()=>f.directory,getRoom:()=>({mods:[{id:'999999999',enabled:true}]})});
 runtime.status=async()=>[{directory:'Master',type:'forest',running:false}];
 let rendered;runtime.mapRenderer.render=async data=>{rendered=data;return {};};
 try {
  fs.appendFileSync(path.join(f.session,'0000000001'),'tablefunctions["mods_fn"] = function()\nreturn {["workshop-123456789"]={active=true},["workshop-222222222"]={active=false}}\nend\n');
  fs.writeFileSync(path.join(f.directory,'Master/modoverrides.lua'),'return {["workshop-123456789"]={enabled=true,configuration_options={example="saved"}},["workshop-333333333"]={enabled=true}}');
  await runtime.mapPreview('0','Master');assert.equal(rendered.mods.length,1);assert.equal(rendered.mods[0].id,'123456789');assert.equal(rendered.mods[0].config.example,'saved');
  fs.writeFileSync(path.join(f.directory,'Master/modoverrides.lua'),'return make_dynamic_overrides()');
  await runtime.mapPreview('0','Master');assert.equal(rendered.mods[0].id,'123456789');
 }finally{f.cleanup();}
});

test('chunked runtime metadata preserves Unicode and incomplete chunks never replace the previous asset cache',async()=>{
 const f=fixture();let count=0,complete=true;
 const assets={terrains:Array.from({length:70},(_,i)=>({name:'动态地形'+i,texture:'levels/textures/test.tex'})),atlases:[],aliases:{}};
 const runtime={store:{cluster:()=>f.directory},command:async(id,command)=>{
  count++;const token=command.match(/FP_[a-f0-9]{20}/)[0],bytes=Buffer.from(JSON.stringify(assets)),chunks=[];
  for(let i=0;i<bytes.length;i+=900)chunks.push(bytes.subarray(i,i+900).toString('hex'));
  const lines=chunks.map((data,i)=>token+'\t'+JSON.stringify({kind:'mapasset',part:i+1,total:chunks.length,data}));
  if(!complete)lines.pop();
  lines.push(token+'\t'+JSON.stringify({kind:'state',players:[],cycles:3}),token+'\t'+JSON.stringify({kind:'done'}));
  fs.writeFileSync(path.join(f.directory,'Master/server_log.txt'),lines.join('\n'));
 }};
 const telemetry=new Telemetry(runtime),world={directory:'Master'};
 try {
  const state=await telemetry.collect('0',world,false);assert.deepEqual(state.mapAssets,assets);
  telemetry.assetCache.get('0:Master').time-=61000;complete=false;
  assert.deepEqual((await telemetry.collect('0',world,false)).mapAssets,assets);assert.equal(count,2);
 }finally{f.cleanup();}
});

