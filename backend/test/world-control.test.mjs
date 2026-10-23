import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorldMetrics, processCounters } from '../src/world-metrics.mjs';
import { createPanel } from '../src/server.mjs';

function procFixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feather-world-metrics-')),proc=path.join(root,'proc'),cgroup=path.join(root,'cgroup'),game=path.join(root,'dst');
  fs.mkdirSync(proc);fs.mkdirSync(cgroup);let now=100000;
  const metrics=new WorldMetrics({proc,cgroup,now:()=>now,memoryTotal:()=>8*1073741824,platform:'linux'});
  fs.writeFileSync(path.join(cgroup,'memory.max'),String(3*1073741824));
  const cpu=total=>fs.writeFileSync(path.join(proc,'stat'),'cpu '+total+' 0 0 0 0 0 0 0 999 999\ncpu0 0\ncpu1 0\n');
  const process=(pid,shard,ticks=100,rss=1024,started=100,cluster='Feather_0',binary=path.join(game,'bin64/dontstarve_dedicated_server_nullrenderer_x64'))=>{
    const directory=path.join(proc,String(pid));fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'cmdline'),[binary,'-cluster',cluster,'-shard',shard,''].join('\0'));
    const fields=Array(30).fill('0');fields[0]='S';fields[11]=String(ticks);fields[12]='0';fields[19]=String(started);
    fs.writeFileSync(path.join(directory,'stat'),pid+' (game (server)) '+fields.join(' '));
    fs.writeFileSync(path.join(directory,'status'),'Name:\tserver\nVmRSS:\t'+rss+' kB\n');
  };
  const worlds=[{directory:'Master',running:true},{directory:'Caves',running:true},{directory:'Shard3',running:false}];
  return {root,proc,cgroup,game,metrics,cpu,process,worlds,advance:()=>now+=1000,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('world CPU uses per-process interval counters and memory uses that shard RSS and container limit',()=>{
  const f=procFixture();try{
    f.cpu(10000);f.process(10,'Master',100,1048576);f.process(11,'Caves',50,524288);
    f.process(12,'Master',900,900000,100,'Feather_other');f.process(13,'Master',900,900000,100,'Feather_0','/usr/bin/screen');
    let result=f.metrics.sample('0',f.worlds,f.game);assert.equal(result[0].resources.cpuPercent,null);assert.equal(result[0].resources.memoryBytes,1073741824);assert.equal(result[0].resources.memoryPercent,33.3);assert.equal(result[0].resources.processCount,1);
    assert.equal(result[1].resources.memoryBytes,536870912);assert.equal(result[2].resources.memoryBytes,0);
    f.advance();f.cpu(10200);f.process(10,'Master',125,1048576);f.process(11,'Caves',60,524288);
    result=f.metrics.sample('0',f.worlds,f.game);assert.equal(result[0].resources.cpuPercent,25);assert.equal(result[1].resources.cpuPercent,10);
    f.advance();f.cpu(10400);f.process(10,'Master',300,1048576);
    assert.equal(f.metrics.sample('0',f.worlds,f.game)[0].resources.cpuPercent,175,'multi-core CPU must not be clipped');
    assert.equal(processCounters('42 (name with ) brackets) '+['S',...Array(29).fill('0')].join(' ')).ticks,0);
  }finally{f.cleanup();}
});
test('PID reuse resets CPU; exited and unreadable processes never display stale memory',()=>{
  const f=procFixture();try{
    f.cpu(10000);f.process(10,'Master',100);f.metrics.sample('0',f.worlds,f.game);
    f.advance();f.cpu(10200);f.process(10,'Master',500,3000,200);
    let result=f.metrics.sample('0',f.worlds,f.game);assert.equal(result[0].resources.cpuPercent,null);assert.equal(result[0].resources.memoryBytes,3000*1024);assert.equal(result[1].resources.available,false);assert.equal(result[1].resources.memoryBytes,null);
    f.advance();fs.rmSync(path.join(f.proc,'10'),{recursive:true});f.cpu(10400);
    result=f.metrics.sample('0',f.worlds,f.game);assert.equal(result[0].resources.memoryBytes,null);assert.equal(result[0].resources.available,false);
    const stopped=f.metrics.sample('0',f.worlds.map(world=>({...world,running:false})),f.game);assert.ok(stopped.every(world=>world.resources.cpuPercent===0&&world.resources.memoryBytes===0));
    f.advance();fs.rmSync(path.join(f.proc,'stat'));assert.equal(f.metrics.sample('0',f.worlds,f.game)[0].resources.cpuPercent,null);
    fs.writeFileSync(path.join(f.cgroup,'memory.max'),'max');assert.equal(f.metrics.memoryLimit(),8*1073741824);
    fs.mkdirSync(path.join(f.cgroup,'memory'));fs.writeFileSync(path.join(f.cgroup,'memory/memory.limit_in_bytes'),String(2*1073741824));assert.equal(f.metrics.memoryLimit(),2*1073741824);
  }finally{f.cleanup();}
});

const settle=async(app,id)=>{for(let i=0;i<200;i++){const task=app.store.getTask(id);if(['succeeded','failed'].includes(task.state))return task;await new Promise(r=>setTimeout(r,10));}throw Error('task timeout');};
test('authenticated world control scopes commands, respects room locks, and records failed starts',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feather-world-api-')),app=createPanel({data:directory,translationProvider:'off'});
  try{
    app.store.putRoom('0',{worlds:[{directory:'Master',running:true},{directory:'Caves',running:false}],mods:[]});
    app.runtime.sessions=async()=>new Set(['Feather_0_Master']);
    const states={Master:true,Caves:false},calls=[];
    app.runtime.status=async()=>Object.entries(states).map(([directory,running])=>({directory,running}));
    app.runtime.start=async(id,worlds)=>{calls.push(['start',worlds]);for(const world of worlds)states[world]=true;};
    app.runtime.stop=async(id,worlds)=>{calls.push(['stop',worlds]);for(const world of worlds)states[world]=false;return {stopped:true};};
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port+'/api/rooms/0',headers={Authorization:'Bearer '+app.store.adminToken,'Content-Type':'application/json'};
    const control=async(worldID,action)=>fetch(base+'/worlds/control',{method:'POST',headers,body:JSON.stringify({worldID,action})});
    assert.equal((await fetch(base+'/worlds')).status,401);
    assert.equal((await control('../Master','start')).status,404);assert.equal((await control('Caves','reset')).status,400);assert.equal(calls.length,0);
    let response=await control('Caves','start');assert.equal(response.status,202);let task=await settle(app,(await response.json()).data.taskID);assert.equal(task.state,'succeeded');assert.deepEqual(calls,[['start',['Caves']]]);assert.equal(states.Master,true);
    response=await control('Master','stop');task=await settle(app,(await response.json()).data.taskID);assert.equal(task.result.stopped,true);assert.equal(states.Caves,true);assert.deepEqual(calls.at(-1),['stop',['Master']]);
    app.store.locks.add('0');response=await control('Caves','stop');task=await settle(app,(await response.json()).data.taskID);assert.equal(task.state,'failed');assert.match(task.error,/操作进行中/);assert.equal(states.Caves,true);
    const status=await(await fetch(base+'/worlds',{headers})).json();assert.equal(status.data.operationPending,true);assert.equal(status.data.worlds[0].resources.memoryBytes,0);app.store.locks.delete('0');
    app.runtime.start=async()=>{};response=await control('Master','start');task=await settle(app,(await response.json()).data.taskID);assert.equal(task.state,'failed');assert.match(task.error,/未能保持运行/);
    app.runtime.stop=async()=>{throw Error('游戏尚未安全退出');};response=await control('Caves','stop');task=await settle(app,(await response.json()).data.taskID);assert.equal(task.state,'failed');assert.match(task.error,/尚未安全退出/);assert.equal(states.Caves,true);
  }finally{await new Promise(r=>app.server.close(r));app.close();fs.rmSync(directory,{recursive:true,force:true});}
});
