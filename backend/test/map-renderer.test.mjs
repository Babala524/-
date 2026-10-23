import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MapRenderer} from '../src/map-renderer.mjs';
import {configuration,exec,root} from '../src/core.mjs';

test('KTEX rendering shows patterns, target icons and roads; caches content and serializes worlds',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feather-assets-')),config=configuration({game:directory});
  try{
    await exec(config.python,[path.join(root,'backend/test/map-assets.py'),directory]);
    const renderer=new MapRenderer(config),size=20;
    const plain={width:size,height:size,names:{7:'FOREST',6:'GRASS'},tiles:Array.from({length:size*size},(_,i)=>i%size<10?7:6)};
    const marked={...plain,entities:[{prefab:'walrus_camp',x:0,z:0},{prefab:'wasphive',x:16,z:16}],roads:[[1,[-16,-16],[16,16]]]};
    let active=0,maxActive=0,runs=0;const run=renderer.run.bind(renderer);
    renderer.run=async(...args)=>{active++;runs++;maxActive=Math.max(maxActive,active);try{return await run(...args);}finally{active--;}};
    const [a,duplicate,b]=await Promise.all([renderer.render(plain),renderer.render(structuredClone(plain)),renderer.render(marked)]);
    assert.equal(a,duplicate);assert.equal(runs,2);assert.equal(maxActive,1);assert.equal(b.renderer,'klei-textures-v1');
    assert.equal(b.iconCount,2);assert.equal(b.roadCount,1);assert.equal(b.imageWidth,160);assert.deepEqual(b.missingTerrains,[]);assert.notEqual(a.image,b.image);
    const png=Buffer.from(b.image.split(',')[1],'base64');assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),160);
    await renderer.render({...plain,collectedAt:'changed timestamp'});assert.equal(runs,2);
    const legacy=await renderer.render({...plain,entities:[{prefab:'killerbeehive',x:0,z:0}]});assert.equal(legacy.iconCount,1);
    const crowded=await renderer.render({...plain,entities:[...Array.from({length:12000},()=>({prefab:'unmapped_grass',x:0,z:0})),{prefab:'wasphive',x:0,z:0}]},{quality:'preview'});assert.equal(crowded.iconCount,1);
    const unknown=await renderer.render({...plain,tiles:plain.tiles.map(n=>n===7?999:n)});assert.deepEqual(unknown.missingTerrains,['999']);
    await assert.rejects(renderer.render({...plain,tiles:[7]}),error=>error.status===422&&/Incomplete/.test(error.message));
    const noAssets=new MapRenderer({...config,game:path.join(directory,'absent')});await assert.rejects(noAssets.render(plain),error=>error.status===409&&/原版/.test(error.message));
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
