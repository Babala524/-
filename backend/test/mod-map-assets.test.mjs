import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ModMapAssets} from '../src/mod-map-assets.mjs';
import {MapRenderer} from '../src/map-renderer.mjs';
import {configuration,exec,root} from '../src/core.mjs';

test('enabled mod terrain, custom edge, registered atlas and prefab icon render; updates invalidate cache',async()=>{
 const game=fs.mkdtempSync(path.join(os.tmpdir(),'feather-map-mods-')),config=configuration({game});
 try {
  await exec(config.python,[path.join(root,'backend/test/map-assets.py'),game]);
  const folder=path.join(game,'mods/workshop-123456789'),write=(name,text)=>{const file=path.join(folder,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
  const copy=(from,to)=>write(to,fs.readFileSync(path.join(game,'data',from)));
  const script=write('modworldgenmain.lua',`local prefix='CUSTOM_'
local mini={name='custom_edge',noise_texture='textures/custom.tex'}
AddTile(prefix..'MEADOW','LAND',{}, {noise_texture='unused'},mini)
AddTile('CUSTOM_SEA','OCEAN',{}, {},{name='map_edge',noise_texture='textures/custom.tex'})
-- AddTile('COMMENT','LAND',{}, {}, {noise_texture='not-real'})
local paths={'custom'};for _,v in ipairs(paths) do AddMinimapAtlas('icons/'..v..'.xml') end
SetMiniMapTileProperty(WORLD_TILES.GRASS,'noise_texture','textures/custom.tex')
`);
  write('scripts/prefabs/custom_structure.lua',`local function fn() inst.MiniMapEntity:SetIcon('igloo.tex');;return inst end;return Prefab('custom_structure',fn)`);
  copy('levels/textures/grass.tex','textures/custom.tex');copy('levels/tiles/map_edge.tex','levels/tiles/custom_edge.tex');copy('levels/tiles/map_edge.xml','levels/tiles/custom_edge.xml');
  copy('minimap/test.tex','icons/test.tex');copy('minimap/minimap_data1.xml','icons/custom.xml');
  const mods=[{id:'123456789',enabled:true}],reader=new ModMapAssets(config),manifest=reader.collect(mods);
  assert.deepEqual(manifest.terrains.map(t=>t.name),['CUSTOM_MEADOW','CUSTOM_SEA']);assert.equal(manifest.atlases.length,1);assert.equal(manifest.aliases.custom_structure,'igloo.tex');assert.deepEqual(manifest.warnings,[]);
  assert.equal(manifest.overrides[0].name,'GRASS');assert.equal(manifest.terrains[0].edge,path.join(folder,'levels/tiles/custom_edge.tex'));
  const renderer=new MapRenderer(config),data={width:20,height:20,names:{7:'CUSTOM_MEADOW'},tiles:Array(400).fill(7),entities:[{prefab:'custom_structure',x:0,z:0}],mods};
  const image=await renderer.render(data);assert.deepEqual(image.missingTerrains,[]);assert.deepEqual(image.modAssets.warnings,[]);assert.equal(image.iconCount,1);assert.equal(image.modAssets.terrainDefinitions,2);
  const dynamic=await renderer.render({...data,names:{7:'DYNAMIC_MEADOW'},liveMapAssets:{terrains:[{name:'DYNAMIC_MEADOW',texture:'../mods/workshop-123456789/textures/custom.tex'}]}});
  assert.deepEqual(dynamic.missingTerrains,[]);assert.equal(dynamic.modAssets.runtimeResolved,true);assert.equal(dynamic.iconCount,1);
  const disabled=await renderer.render({...data,mods:[]});assert.deepEqual(disabled.missingTerrains,['CUSTOM_MEADOW']);assert.equal(disabled.iconCount,0);
  const before=reader.collect(mods).signature,texture=path.join(folder,'textures/custom.tex'),bytes=fs.readFileSync(texture);bytes.fill(240,18);fs.writeFileSync(texture,bytes);
  assert.notEqual(reader.collect(mods).signature,before);assert.notEqual((await renderer.render(data)).image,image.image);
  fs.appendFileSync(script,`\nAddTile('MISSING','LAND',{}, {},{noise_texture='nonexistent'})`);
  assert.match(reader.collect(mods).warnings.join('\n'),/MISSING/);
 }finally{fs.rmSync(game,{recursive:true,force:true});}
});

test('dynamic Lua, comments, path traversal and disabled mods cannot execute or load outside assets',()=>{
 const game=fs.mkdtempSync(path.join(os.tmpdir(),'feather-map-metadata-')),config={game};
 try {
  const folder=path.join(game,'mods/workshop-123456789');fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'modmain.lua'),`os.execute('SHOULD_NEVER_RUN');
local dangerous='../../outside.xml';AddMinimapAtlas(dangerous)
AddTile(dynamic_name(),'LAND',{}, {},dynamic_mini())
-- AddMinimapAtlas('comment.xml')
`);
  const reader=new ModMapAssets(config),data=reader.collect([{id:'123456789'}]);assert.deepEqual(data.atlases,[]);assert.deepEqual(data.terrains,[]);assert.match(data.warnings.join('\n'),/动态/);
  assert.deepEqual(reader.collect([]).mods,[]);assert.deepEqual(reader.collect([{id:'../outside'}]).mods,[]);
 }finally{fs.rmSync(game,{recursive:true,force:true});}
});

test('runtime registrations resolve normalized game paths, override static branches and retain unresolved warnings',()=>{
 const game=fs.mkdtempSync(path.join(os.tmpdir(),'feather-map-live-'));
 try {
  const folder=path.join(game,'mods/workshop-123456789');fs.mkdirSync(folder,{recursive:true});
  const texture=path.join(folder,'custom.tex');fs.writeFileSync(texture,'test');
  fs.writeFileSync(path.join(folder,'modmain.lua'),`AddTile('LIVE','LAND',{},{},{noise_texture=dynamic()});SetMiniMapTileProperty(WORLD_TILES.LIVE,'noise_texture','absent');AddMinimapAtlas(dynamic())`);
  const reader=new ModMapAssets({game}),mods=[{id:'123456789'}];
  const live={terrains:[{name:'LIVE',texture:'../mods/workshop-123456789/custom.tex'},{name:'FORBIDDEN',texture:'../../outside.tex'}],atlases:[]};
  const found=reader.collect(mods,live);
  assert.equal(found.terrains.length,1);assert.equal(found.terrains[0].texture,texture);assert.equal(found.terrains[0].runtime,true);assert.equal(found.terrains[0].order,0);
  assert.deepEqual(found.overrides,[]);assert.equal(found.runtimeResolved,true);assert.match(found.warnings.join('\n'),/图集路径无法解析/);assert.match(found.warnings.join('\n'),/FORBIDDEN/);
  assert.equal(reader.collect(mods,{}).runtimeResolved,false);assert.deepEqual(reader.collect([{id:'123456789',enabled:false}],live).terrains,[]);
 }finally{fs.rmSync(game,{recursive:true,force:true});}
});
