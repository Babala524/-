import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {levelData} from '../src/lua.mjs';

const context=vm.createContext({window:{}});
for(const file of ['vendor/dmp-browser.js','assets/world-customize.js'])vm.runInContext(fs.readFileSync(new URL('../../'+file,import.meta.url),'utf8'),context);
const dmp=context.window.FeatherDmp,customize=context.window.FeatherWorldCustomize;
const describe=(world)=>customize.model(world,dmp.readLevelDataOverrides(world.levelData),dmp,{});

test('generated mod presets satisfy the game shardindex required level metadata',()=>{
  // scripts/shardindex.lua GetLevelDataOverride asserts all five fields.
  for(const location of ['shipwrecked','porkland','volcanoworld'])for(const mode of ['endless','survival','relaxed','wilderness','lightsOut']){
    const data=levelData(customize.preset(location,mode,dmp));
    for(const key of ['id','name','desc','location'])assert.ok(typeof data[key]==='string'&&data[key].length>0,location+'/'+mode+' requires '+key);
    assert.ok(data.overrides&&typeof data.overrides==='object');
  }
});

test('uploaded location overrides process type and custom values all appear once',()=>{
  const world={type:'caves',levelData:'-- location="cave"\nreturn {location="porkland",overrides={fog="default",temperate="longseason",pog="often",task_set="porkland",custom_thing="anything",custom_number=-2.5,custom_bool=true,custom_table={x=4}}}'};
  const view=describe(world);assert.equal(view.location,'porkland');assert.equal(view.title,'猪镇');
  const keys=Array.from(view.groups).flatMap(g=>Array.from(g.keys));assert.equal(new Set(keys).size,8);assert.equal(keys.length,8);
  assert.ok(view.groups.some(g=>g.title==='猪镇 · 季节规则'&&g.keys.includes('temperate')));
  assert.deepEqual(Array.from(view.definitions.get('fog').configs),['never','default']);
  assert.ok(view.definitions.get('custom_thing').raw);assert.ok(view.definitions.get('task_set').raw);
  assert.ok(!view.groups.some(g=>g.id==='gen-caves'));
});

test('Shipwrecked seasons and core options use their own values and retain unknown current values',()=>{
  const world={type:'forest',levelData:'return {location="shipwrecked",overrides={shipwrecked_season_start="wet",monsoon="shortseason",bamboo="insane",poison="always",ia_boats="none",start_location="shipwrecked_default",future_option="future"}}'};
  const view=describe(world);assert.equal(view.title,'海难');
  assert.ok(view.definitions.get('shipwrecked_season_start').configs.includes('wet'));
  assert.ok(!view.definitions.get('shipwrecked_season_start').configs.includes('winter'));
  assert.deepEqual(Array.from(view.definitions.get('poison').configs),['none','always']);
  assert.equal(view.definitions.get('bamboo').i18n.zh,'竹子');
  assert.ok(view.definitions.get('start_location').raw);
  const changed=dmp.replaceLevelDataOverride(world.levelData,'monsoon','string','longseason');
  assert.equal(changed,world.levelData.replace('monsoon="shortseason"','monsoon="longseason"'));
  assert.equal(dmp.readLevelDataOverrides(changed).metadata.location,'shipwrecked');
});

test('native worlds retain their own definitions, unknown fields and literal metadata',()=>{
  const world={type:'caves',levelData:'return {location="forest",overrides={season_start="winter",unknown="other"}}'};
  const view=describe(world);assert.equal(view.title,'森林');assert.equal(view.groups.flatMap(g=>g.keys).length,2);
  assert.ok(view.definitions.get('season_start').configs.includes('winter'));assert.ok(view.definitions.get('unknown').raw);
  const fallback=describe({type:'caves',levelData:'return {overrides={custom=true}}'});assert.equal(fallback.title,'洞穴');
});

test('no-code presets generate mod locations, task sets and correctly typed generation flags',()=>{
  for(const location of ['shipwrecked','porkland']){
    const source=customize.preset(location,'endless',dmp),data=levelData(source),parsed=dmp.validateLevelData(source);
    assert.equal(data.location,location);assert.equal(data.overrides.task_set,location);
    assert.equal(data.overrides.start_location,location==='porkland'?'PorkLandStart':'shipwrecked_default');
    assert.equal(data.overrides.has_ocean,true);assert.equal(data.overrides.keep_disconnected_tiles,true);
    assert.equal(data.overrides.layout_mode,location==='porkland'?'RestrictNodesByKey':'LinkNodesByKeys');
    assert.equal(data.overrides.ia_boats,'always');assert.equal(data.overrides.dst_boats,'none');
    assert.equal(data.overrides.portalresurection,'always');assert.equal(data.overrides.resettime,'none');
    assert.equal(data.override_level_string,false);assert.deepEqual(Array.from(data.required_prefabs),['multiplayer_portal']);
    const view=describe({type:'caves',levelData:source}),keys=view.groups.flatMap(g=>Array.from(g.keys));
    assert.equal(view.location,location);assert.equal(new Set(keys).size,parsed.entries.length);assert.equal(keys.length,parsed.entries.length);
    assert.ok(view.groups.some(g=>g.title.includes(location==='porkland'?'猪镇':'海难')));
    for(const nativeSeason of ['autumn','winter','spring','summer'])assert.equal(Object.hasOwn(data.overrides,nativeSeason),false);
    if(location==='porkland'){assert.equal(data.overrides.no_joining_islands,false);assert.equal(data.overrides.deerclops,'never');assert.equal(data.overrides.pl_clocktype,'porkland');}
  }
});

test('mode presets preserve mod world generation and reject incompatible game modes',()=>{
  const original=JSON.stringify(dmp.presets);
  for(const location of ['shipwrecked','porkland'])for(const mode of ['endless','survival','relaxed','wilderness','lightsOut']){
    const data=levelData(customize.preset(location,mode,dmp));
    assert.equal(data.location,location);assert.equal(data.overrides.task_set,location);
    if(mode==='wilderness')assert.equal(data.overrides.ghostenabled,'none');
    if(mode==='relaxed')assert.equal(data.overrides.hunger,'nonlethal');
    if(mode==='lightsOut')assert.equal(data.overrides.day,'onlynight');
    if(location==='shipwrecked'&&mode==='lightsOut')assert.equal(data.overrides.start_location,'shipwrecked_darkness');
    assert.equal(data.id,location==='porkland'?'PORKLAND_DEFAULT':{endless:'SHIPWRECKED_ENDLESS',survival:'SURVIVAL_SHIPWRECKED_CLASSIC',relaxed:'SHIPWRECKED_RELAXED',wilderness:'SHIPWRECKED_WILDERNESS',lightsOut:'SHIPWRECKED_LIGHTS_OUT'}[mode]);
  }
  assert.equal(JSON.stringify(dmp.presets),original);
  assert.throws(()=>customize.preset('porkland','lavaarena',dmp),/支持/);
  assert.throws(()=>customize.preset('shipwrecked','quagmire',dmp),/支持/);
  assert.throws(()=>customize.preset('unknown','endless',dmp),/保留原配置/);
});

test('Volcano presets use the registered task set, start, dry terrain and classic generation bounds',()=>{
  for(const mode of ['endless','survival','relaxed','wilderness','lightsOut']){
    const source=customize.preset('volcanoworld',mode,dmp),data=levelData(source),parsed=dmp.validateLevelData(source);
    assert.equal(data.location,'volcanoworld');assert.equal(data.overrides.task_set,'volcano');
    assert.equal(data.overrides.start_location,'volcano_default');assert.equal(data.overrides.world_size,'small');
    assert.equal(data.overrides.has_ocean,false);assert.equal(data.overrides.keep_disconnected_tiles,true);
    assert.equal(data.overrides.layout_mode,'LinkNodesByKeys');assert.equal(data.overrides.clocktype,'tropical');
    for(const key of ['boons','poi','traps','grassgekkos'])assert.equal(data.overrides[key],'never');
    assert.equal(data.overrides.prefabswaps_start,'classic');assert.equal(data.version,4);
    assert.equal(data.id,'SURVIVAL_VOLCANO_CLASSIC');assert.equal(data.worldgen_id,data.id);assert.equal(data.settings_id,data.id);
    assert.deepEqual(Array.from(data.background_node_range),[0,0]);
    assert.deepEqual(Array.from(data.required_prefabs),['multiplayer_portal']);
    for(const key of ['volcano','volcanoisland','seaweed','bamboo','whalehunt','floods','tides','oceanwaves','primaryworldtype'])assert.equal(Object.hasOwn(data.overrides,key),false,key);
    for(const key of ['magma_rocks','coffeebush','elephantcactus','rock_obsidian','rock_charcoal','volcano_shrub','dragoon','dragoonegg'])assert.equal(data.overrides[key],'default');
    if(mode==='wilderness')assert.equal(data.overrides.ghostenabled,'none');
    if(mode==='relaxed')assert.equal(data.overrides.hunger,'nonlethal');
    if(mode==='lightsOut')assert.equal(data.overrides.day,'onlynight');
    const view=describe({type:'caves',levelData:source}),keys=view.groups.flatMap(g=>Array.from(g.keys));
    assert.equal(view.location,'volcanoworld');assert.equal(view.title,'火山');
    assert.equal(keys.length,parsed.entries.length);assert.equal(new Set(keys).size,keys.length);
    assert.ok(view.groups.some(g=>g.title==='火山 · 资源生成'&&g.keys.includes('coffeebush')));
    assert.ok(!view.groups.some(g=>g.title.startsWith('海难 ·')));
    for(const key of ['magma_rocks','coffeebush','elephantcactus','rock_obsidian','rock_charcoal','volcano_shrub','dragoon','dragoonegg']){
      assert.ok(view.definitions.get(key).image,key+' has its mod icon');
      assert.ok(fs.existsSync(new URL('../../assets/world-icons/'+view.definitions.get(key).image,import.meta.url)));
    }
  }
  assert.throws(()=>customize.preset('volcanoworld','lavaarena',dmp),/支持/);
});

test('imported Volcano configuration keeps custom fields and supports task-only location detection',()=>{
  const source='-- 火山配置\nreturn {overrides={task_set="volcano",start_location="volcano_default",coffeebush="often",has_ocean=false,custom_mod={nested=true},seaweed="rare"}}';
  const view=describe({type:'caves',levelData:source});assert.equal(view.location,'volcanoworld');
  assert.equal(view.definitions.get('coffeebush').i18n.zh,'咖啡丛');
  assert.equal(view.definitions.get('custom_mod').raw,true);assert.equal(view.definitions.get('start_location').raw,true);
  const keys=view.groups.flatMap(g=>Array.from(g.keys));assert.equal(new Set(keys).size,6);assert.equal(keys.length,6);
  const changed=dmp.replaceLevelDataOverride(source,'coffeebush','string','rare');
  assert.equal(changed,source.replace('coffeebush="often"','coffeebush="rare"'));
  assert.equal(levelData(changed).overrides.custom_mod.nested,true);
  assert.equal(levelData(changed).overrides.has_ocean,false);
  assert.equal(describe({type:'forest',levelData:'return {location="shipwrecked",overrides={task_set="volcano"}}'}).location,'shipwrecked');
});
