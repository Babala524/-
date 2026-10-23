import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readEnvironment,maintenance} from '../scripts/native-maintenance.mjs';

test('native server starts through the current-release directory link',{timeout:20000},async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-native-entry-'));
 let child;
 try{
  const entry=path.join(data,'current');
  fs.symlinkSync(fileURLToPath(new URL('../src/',import.meta.url)),entry,process.platform==='win32'?'junction':'dir');
  const socket=http.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  child=spawn(process.execPath,[path.join(entry,'server.mjs')],{env:{...process.env,FEATHER_DATA:path.join(data,'data'),FEATHER_PORT:String(port),FEATHER_HOST:'127.0.0.1',FEATHER_ADMIN_TOKEN:'native-entry-test-secret-123456',FEATHER_MOD_REGISTRY:'',FEATHER_MOD_REGISTRY_HOST:'0'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  let healthy=false;
  for(let n=0;n<100;n++){
   if(child.exitCode!==null)break;
   try{const response=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(1000)});healthy=response.ok&&(await response.json()).service==='FeatherPanel';if(healthy)break;}catch{}
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(healthy,true,output||'server exited without listening');
 }finally{
  if(child&&child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await closed;}
  fs.rmSync(data,{recursive:true,force:true});
 }
});

test('native maintenance reads literal environment values without executing shell content',()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-native-env-'));try{
  const file=path.join(data,'env');fs.writeFileSync(file,'# settings\nFEATHER_PORT=18081\nVALUE="$(touch /tmp/not-executed)"\nTOKEN=literal#value\n');
  assert.deepEqual(readEnvironment(file),{FEATHER_PORT:'18081',VALUE:'$(touch /tmp/not-executed)',TOKEN:'literal#value'});
  fs.writeFileSync(file,'export FEATHER_PORT=80\n');assert.throws(()=>readEnvironment(file),/格式不合法/);
 }finally{fs.rmSync(data,{recursive:true,force:true});}
});

async function fixture(run,{failStop=false}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-native-maintenance-')),state=path.join(data,'worlds.json'),calls=[];
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/healthz'){res.end(JSON.stringify({service:'FeatherPanel'}));return;}
  if(req.headers.authorization!=='Bearer native-test-secret'){res.writeHead(401);res.end('{"error":"unauthorized"}');return;}
  let body='';for await(const chunk of req)body+=chunk;const input=body?JSON.parse(body):null;calls.push([req.url,input]);
  let value;
  if(req.url==='/api/rooms')value=[{id:'0'},{id:'other'}];
  else if(req.url==='/api/rooms/0/worlds')value={worlds:[{directory:'Master',running:true},{directory:'Caves',running:false}]};
  else if(req.url==='/api/rooms/other/worlds')value={worlds:[{directory:'Island',running:true}]};
  else if(req.url.endsWith('/control'))value={taskID:req.url.includes('/worlds/')?'start-task':'stop-task'};
  else if(req.url.startsWith('/api/tasks/'))value={state:failStop?'failed':'succeeded',error:'safe stop failed'};
  else{res.writeHead(404);res.end('{}');return;}
  res.end(JSON.stringify({data:value}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const env={FEATHER_PORT:String(server.address().port),FEATHER_ADMIN_TOKEN:'native-test-secret'};
 try{await run({state,calls,env});}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(data,{recursive:true,force:true});}
}
test('native update records only running worlds, stops rooms and restores the exact world selection',()=>fixture(async({state,calls,env})=>{
 await maintenance('health',null,env);
 await maintenance('stop',state,env);
 assert.deepEqual(JSON.parse(fs.readFileSync(state,'utf8')),[{room:'0',worlds:['Master']},{room:'other',worlds:['Island']}]);
 await maintenance('restore',state,env);
 assert.deepEqual(calls.filter(([route])=>route.endsWith('/worlds/control')).map(([route,body])=>[route,body]),[
  ['/api/rooms/0/worlds/control',{action:'start',worldID:'Master'}],['/api/rooms/other/worlds/control',{action:'start',worldID:'Island'}]
 ]);
}));
test('failed game shutdown aborts maintenance while preserving the original running-world record',()=>fixture(async({state,calls,env})=>{
 await assert.rejects(maintenance('stop',state,env),/safe stop failed/);
 assert.equal(JSON.parse(fs.readFileSync(state,'utf8'))[0].worlds[0],'Master');
 assert.equal(calls.some(([route])=>route.endsWith('/worlds/control')),false);
},{failStop:true}));
