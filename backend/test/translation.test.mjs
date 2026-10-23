import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPanel } from '../src/server.mjs';
import { configuration, Store } from '../src/core.mjs';
import { ModAutoTranslate, translationSegments } from '../src/mod-auto-translate.mjs';
const raw=()=>[{name:'temperature',label:'Nearby temperature',hover:'Show the temperature of nearby creatures.',default:false,options:[{description:'Enabled',data:true},{description:'Disabled',data:false}]}];
const response=text=>({ok:true,status:200,json:async()=>({responseStatus:200,responseData:{translatedText:text}})});
async function settle(service){for(let i=0;i<300;i++){if(!service.running&&!service.queue.length)return;await new Promise(r=>setTimeout(r,10));}throw Error('Translation queue did not finish');}
function fixture(config={}){const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-translate-'));const store=new Store(configuration({data,translationProvider:'mymemory',...config}));return {data,store,service:new ModAutoTranslate(store),close(){this.service.close();this.store.close();fs.rmSync(data,{recursive:true,force:true});}};}

test('automatic translation deduplicates requests, prefers reviewed text, preserves originals and actual values, and persists cache',async()=>{
 const f=fixture();try{
  const original=raw();let calls=0;
  f.service.fetch=async url=>{calls++;const q=url.searchParams.get('q');return response(q==='Nearby temperature'?'附近温度':'显示附近生物的温度。');};
  const initial=f.service.fields(original);assert.equal(initial.translation.pending,2);assert.equal(initial.fields[0].label,original[0].label);f.service.fields(original);
  await settle(f.service);const result=f.service.fields(original);assert.equal(calls,2);assert.equal(result.translation.state,'complete');assert.equal(result.fields[0].label,'附近温度');assert.equal(result.fields[0].options[0].description,'开启');assert.equal(result.fields[0].originalHover,original[0].hover);assert.equal(result.fields[0].name,'temperature');assert.equal(result.fields[0].default,false);assert.equal(result.fields[0].options[1].data,false);assert.equal(original[0].label,'Nearby temperature');
  f.service.close();f.store.close();f.store=new Store(configuration({data:f.data,translationProvider:'mymemory'}));f.service=new ModAutoTranslate(f.store);f.service.fetch=async()=>{throw Error('cache should avoid the network');};assert.equal(f.service.fields(original).translation.translated,2);
 }finally{f.close();}
});

test('service failures preserve source, permit explicit retry and reject changed numbers and placeholders',async()=>{
 const f=fixture();try{
  const fields=[{name:'damage',label:'Damage 25 at %s',hover:'',default:25,options:[]}];
  f.service.fetch=async()=>response('伤害 50');f.service.fields(fields);await settle(f.service);let result=f.service.fields(fields);assert.equal(result.translation.failed,1);assert.equal(result.fields[0].label,'Damage 25 at %s');
  let calls=0;f.service.fetch=async()=>{calls++;return response('在 %s 处造成 25 伤害');};f.service.fields(fields);assert.equal(calls,0);f.service.fields(fields,{retry:true});await settle(f.service);result=f.service.fields(fields);assert.equal(result.fields[0].label,'在 %s 处造成 25 伤害');assert.equal(result.fields[0].default,25);
 }finally{f.close();}
});

test('quota exhaustion stops queued requests and cooldown survives service recreation',async()=>{
 const f=fixture();try{
  let calls=0;f.service.fetch=async()=>{calls++;return {ok:true,status:200,json:async()=>({quotaFinished:true,responseStatus:429})};};
  f.service.fields(raw());await settle(f.service);const result=f.service.fields(raw());assert.equal(calls,1);assert.equal(result.translation.state,'limited');assert.equal(result.translation.pending,0);assert.equal(result.translation.failed,2);assert.ok(result.translation.retryAt);
  f.service.close();f.service=new ModAutoTranslate(f.store);assert.equal(f.service.fields(raw(),{retry:true}).translation.state,'limited');assert.equal(f.service.queue.length,0);
 }finally{f.close();}
});

test('large descriptions split below provider byte limits and preserve paragraphs',async()=>{
 const source=('The temperature is 25 degrees. '.repeat(40))+'\n\n'+'Keep %s unchanged.';
 const parts=translationSegments(source);assert.equal(parts.join(''),source);assert.ok(parts.every(p=>Buffer.byteLength(p)<=450));assert.ok(parts.includes('\n\n'));
});

test('disabled translator makes no external requests and returns exact source',()=>{
 const f=fixture({translationProvider:'off'});try{f.service.fetch=()=>{throw Error('must not fetch');};const result=f.service.fields(raw());assert.equal(result.translation.state,'disabled');assert.equal(result.translation.pending,0);assert.equal(result.fields[0].label,'Nearby temperature');}finally{f.close();}
});

test('LibreTranslate uses configured server with plain display text and server-side key',async()=>{
 const f=fixture({translationProvider:'libretranslate',translationURL:'http://translate.local:5000/',translationKey:'server-only-test-key'});try{
  let calls=0;f.service.fetch=async(url,options)=>{calls++;assert.equal(url.href,'http://translate.local:5000/translate');const body=JSON.parse(options.body);assert.equal(body.api_key,'server-only-test-key');assert.equal(body.format,'text');assert.equal(body.source,'en');assert.equal(body.target,'zh');return {ok:true,status:200,json:async()=>({translatedText:body.q==='Nearby temperature'?'附近温度':'显示附近生物的温度。'})};};
  f.service.fields(raw());await settle(f.service);const result=f.service.fields(raw());assert.equal(calls,2);assert.equal(result.translation.state,'complete');assert.doesNotMatch(JSON.stringify(result),/server-only-test-key|translate.local/);
 }finally{f.close();}
});

test('authenticated config HTTP responds before translation finishes and accepts explicit retry',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-translate-http-'));
 const app=createPanel({data,game:path.join(data,'dst'),translationProvider:'mymemory',adminToken:'test-administrator-secret-is-long-enough'});
 try{
  app.store.putRoom('0',{mods:[{id:'123456789',config:{temperature:true}}]});const folder=path.join(data,'dst/mods/workshop-123456789');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'modinfo.lua'),'configuration_options={{name="temperature",label="Nearby temperature",default=false,options={{description="Enabled",data=true},{description="Disabled",data=false}}}}');
  let release;app.mods.translation.fetch=()=>new Promise(resolve=>release=resolve);
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const url=`http://127.0.0.1:${app.server.address().port}/api/rooms/0/mods/config`,options={method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+app.store.adminToken},body:JSON.stringify({modID:'123456789',retryTranslation:true})};
  const pending=await(await fetch(url,options)).json();assert.equal(pending.data.translation.pending,1);assert.equal(pending.data.values.temperature,true);release(response('附近温度'));await settle(app.mods.translation);
  const result=await(await fetch(url,options)).json();assert.equal(result.data.translation.state,'complete');assert.equal(result.data.fields[0].label,'附近温度');assert.equal(result.data.fields[0].default,false);assert.equal(result.data.values.temperature,true);
  assert.equal((await fetch(url,{...options,headers:{'Content-Type':'application/json'}})).status,401);
 }finally{app.mods.translation.close();await new Promise(r=>app.server.close(r));app.close();fs.rmSync(data,{recursive:true,force:true});}
});
