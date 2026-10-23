import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createPanel} from '../src/server.mjs';
import {presets} from '../src/lua.mjs';
import {GameUpdateProgress,gameUpdateOutcome,runSteamUpdate} from '../src/game-update.mjs';
import {GameVersionCheck,installedGameBuild} from '../src/game-version.mjs';

test('game update requires authentication and stopped worlds, holds shared lock, and releases it after failure',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-update-'));
  const app=createPanel({data,game:path.join(data,'dst'),steam:path.join(data,'steam'),translationProvider:'off',adminToken:'update-test-secret-with-enough-length',clusterToken:'test'});
  app.stopTimers();app.runtime.sessions=async()=>new Set();
  app.runtime.gameVersions.fetcher=async()=>new Response('{"data":{"343050":{"depots":{"branches":{"public":{"buildid":"100"}}}}}}');
  let release;
  try{
    await app.rooms.save('0',{name:'Update test',password:'',maxPlayers:6,mode:'endless',pvp:false,pause:true,vote:true,worldCount:1,worlds:[{directory:'Master',type:'forest',port:11001,levelData:presets.endless.master}],mods:[],automation:{autoBackup:false,backupTime:'06:00',startType:'64-bit'}});
    app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
    const base='http://127.0.0.1:'+app.server.address().port;
    const headers={Authorization:'Bearer update-test-secret-with-enough-length','Content-Type':'application/json'};
    const post=(url,body={})=>fetch(base+url,{method:'POST',headers,body:JSON.stringify(body)});
    const settle=async taskID=>{for(let i=0;i<200;i++){const state=app.store.getTask(taskID);if(['succeeded','failed'].includes(state.state))return state;await new Promise(r=>setTimeout(r,10));}throw Error('task timeout');};
    assert.equal((await fetch(base+'/api/game/update',{method:'POST'})).status,401);
    assert.equal((await fetch(base+'/api/game/status')).status,401);
    assert.equal((await post('/api/game/update',{validate:'yes'})).status,400);
    assert.equal((await(await fetch(base+'/api/game/status',{headers})).json()).data.installed,false);
    let calls=0;app.runtime.install=async()=>{calls++;return {installed:true};};
    app.runtime.status=async()=>[{directory:'Master',running:true}];
    const blocked=await(await post('/api/game/update')).json();
    assert.match((await settle(blocked.data.taskID)).error,/关闭所有房间/);assert.equal(calls,0);assert.equal(app.store.sharedBusy,false);
    app.runtime.status=async()=>[{directory:'Master',running:false}];
    for(const busy of ['room','mods','shared']){
      if(busy==='room')app.store.locks.add('0');if(busy==='mods')app.mods.jobs.set('123456789',{});if(busy==='shared')app.store.sharedBusy=true;
      assert.equal((await post('/api/game/update')).status,409);
      app.store.locks.clear();app.mods.jobs.clear();app.store.sharedBusy=false;
    }
    let started;const began=new Promise(r=>started=r);
    app.runtime.install=async report=>{calls++;report(null,'STEAM_TEST_RUNNING');started();await new Promise(r=>release=r);return {installed:true};};
    const queued=await(await post('/api/game/update')).json();await began;
    assert.equal(app.store.sharedBusy,true);assert.equal(app.store.getTask(queued.data.taskID).result.message,'STEAM_TEST_RUNNING');
    assert.equal((await post('/api/game/install')).status,409);
    assert.equal((await post('/api/rooms/0/control',{action:'start'})).status,409);
    release();const completed=await settle(queued.data.taskID);assert.equal(completed.kind,'更新游戏');assert.equal(completed.state,'succeeded');assert.equal(completed.result.installed,true);assert.equal(app.store.sharedBusy,false);
    app.runtime.install=async()=>{throw Error('STEAM_FAILURE');};
    const failed=await(await post('/api/game/update')).json();assert.equal((await settle(failed.data.taskID)).error,'STEAM_FAILURE');assert.equal(app.store.sharedBusy,false);
    app.runtime.install=async()=>({installed:true});const retry=await(await post('/api/game/update')).json();assert.equal((await settle(retry.data.taskID)).state,'succeeded');
  }finally{release?.();await new Promise(r=>app.server.close(r));app.close();fs.rmSync(data,{recursive:true,force:true});}
});

test('SteamCMD success must be explicit even if an old game binary exists',{skip:process.platform!=='linux'},async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-steam-result-'));
  const app=createPanel({data,game:path.join(data,'dst'),steam:path.join(data,'steam'),translationProvider:'off'});app.stopTimers();
  try{
    fs.mkdirSync(path.join(data,'steam'),{recursive:true});fs.mkdirSync(path.join(data,'dst/bin64'),{recursive:true});
    fs.writeFileSync(path.join(data,'dst/bin64/dontstarve_dedicated_server_nullrenderer_x64'),'old binary');
    const script=path.join(data,'steam/steamcmd.sh');
    fs.writeFileSync(script,'#!/bin/sh\nprintf "ERROR! Download failed\\n"\n',{mode:0o700});
    await assert.rejects(()=>app.runtime.install(),/安装或更新失败/);
    assert.match(fs.readFileSync(path.join(data,'installation.log'),'utf8'),/Download failed/);
    fs.writeFileSync(script,"#!/bin/sh\nprintf \"Success! App '343050' fully installed.\\n\"\n");
    const events=[];assert.equal((await app.runtime.install((p,message)=>events.push(message))).installed,true);assert.ok(events.length>=2);
    // Streamed progress must arrive while SteamCMD is still running, including
    // percentages split across chunks and carriage-return-only output.
    fs.writeFileSync(script,`#!/bin/sh\nprintf '%s\\n' "$*" > '${path.join(data,'steam-args')}'\nprintf 'Update state (0x61) downloading, progress: 12.'\nsleep 0.2\nprintf '50 (125 / 1000)\\r'\nsleep 1.2\nprintf 'Update state (0x61) downloading, progress: 50.00 (500 / 1000)\\r'\nsleep 1.2\nprintf "Success! App '343050' fully installed.\\n"\n`);
    let completed=false;const streamed=[];
    const running=app.runtime.install((p,message,detail)=>{streamed.push({p,message,detail,beforeComplete:!completed});}).then(result=>{completed=true;return result;});
    const result=await running;assert.equal(result.installed,true);assert.ok(result.elapsedMs>=2000);
    assert.ok(streamed.some(event=>event.p===12.5&&event.beforeComplete));
    assert.ok(streamed.some(event=>event.detail?.bytesPerSecond>0));
    assert.doesNotMatch(fs.readFileSync(path.join(data,'steam-args'),'utf8'),/validate/);
    fs.writeFileSync(script,`#!/bin/sh\nprintf '%s\\n' "$*" > '${path.join(data,'steam-args')}'\nprintf "Success! App '343050' fully installed.\\n"\n`);
    await app.runtime.install(()=>{},{validate:true});assert.match(fs.readFileSync(path.join(data,'steam-args'),'utf8'),/343050 validate/);
    fs.writeFileSync(script,"#!/bin/sh\nprintf \"Success! App '343050' already up to date.\\n\"\n");
    const current=await app.runtime.install();assert.equal(current.installed,true);assert.equal(current.upToDate,true);assert.equal(current.progress,100);
    fs.writeFileSync(script,"#!/bin/sh\nprintf \"Success! App '343050' already up to date.\\n\"\nexit 1\n");
    await assert.rejects(()=>app.runtime.install(),/安装或更新失败/);
    fs.writeFileSync(script,"#!/bin/sh\nprintf \"Success! App '343051' fully installed.\\n\"\n");
    await assert.rejects(()=>app.runtime.install(),/安装或更新失败/);
    fs.unlinkSync(path.join(data,'dst/bin64/dontstarve_dedicated_server_nullrenderer_x64'));
    fs.writeFileSync(script,"#!/bin/sh\nprintf \"Success! App '343050' already up to date.\\n\"\n");
    await assert.rejects(()=>app.runtime.install(),/未找到游戏程序/);
  }finally{app.close();fs.rmSync(data,{recursive:true,force:true});}
});

test('SteamCMD descendants holding stdout cannot stall success or hide a failing exit',{skip:process.platform!=='linux',timeout:12000},async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-steam-pipes-'));
  const app=createPanel({data,game:path.join(data,'dst'),steam:path.join(data,'steam'),translationProvider:'off'});app.stopTimers();
  const descendants=[];
  try {
    fs.mkdirSync(path.join(data,'steam'),{recursive:true});fs.mkdirSync(path.join(data,'dst/bin64'),{recursive:true});
    fs.writeFileSync(path.join(data,'dst/bin64/dontstarve_dedicated_server_nullrenderer_x64'),'fixture binary');
    for(const code of [0,7]) {
      const pidFile=path.join(data,'reporter-'+code);
      fs.writeFileSync(path.join(data,'steam/steamcmd.sh'),`#!/bin/sh\nsleep 20 &\nprintf '%s' "$!" > '${pidFile}'\nprintf "Success! App '343050' fully installed.\\n"\nexit ${code}\n`,{mode:0o700});
      const started=Date.now();
      try {
        if(code===0)assert.equal((await app.runtime.install()).installed,true);
        else await assert.rejects(()=>app.runtime.install(),/安装或更新失败/);
      } finally {if(fs.existsSync(pidFile))descendants.push(Number(fs.readFileSync(pidFile,'utf8')));}
      assert.ok(Date.now()-started<5000,'must not wait for the reporter to exit');
      assert.match(fs.readFileSync(path.join(data,'installation.log'),'utf8'),/fully installed/);
    }
  } finally {
    for(const pid of descendants)try{process.kill(pid,'SIGKILL');}catch{}
    app.close();fs.rmSync(data,{recursive:true,force:true});
  }
});

test('SteamCMD timeout and spawn failure settle and permit another command',{skip:process.platform!=='linux',timeout:5000},async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-steam-timeout-'));
  try {
    const pidFile=path.join(data,'pid');let output='';
    await assert.rejects(()=>runSteamUpdate('/bin/sh',['-c',`printf '%s' "$$" > '${pidFile}'; printf 'starting\\n'; sleep 20`],{timeoutMs:500,onData:text=>output+=text}),{code:'ETIMEDOUT'});
    assert.match(output,/starting/);
    const pid=Number(fs.readFileSync(pidFile,'utf8'));
    for(let i=0;i<50;i++){
      try{process.kill(pid,0);}catch(error){assert.equal(error.code,'ESRCH');break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    await assert.rejects(()=>runSteamUpdate(path.join(data,'missing'),[],{timeoutMs:500}),{code:'ENOENT'});
    assert.deepEqual(await runSteamUpdate('/bin/sh',['-c','exit 0'],{timeoutMs:500}),{code:0,signal:null});
  } finally {fs.rmSync(data,{recursive:true,force:true});}
});

test('SteamCMD update can be cancelled through its process group',{skip:process.platform!=='linux',timeout:7000},async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-steam-cancel-'));
  try {
    const controller=new AbortController();let output='';
    const running=runSteamUpdate('/bin/sh',['-c','printf "starting\\n"; sleep 20'],{timeoutMs:5000,idleTimeoutMs:5000,signal:controller.signal,onData:text=>output+=text});
    await new Promise(resolve=>setTimeout(resolve,100));controller.abort();
    await assert.rejects(running,{code:'ECANCELED'});assert.match(output,/starting/);
  } finally {fs.rmSync(data,{recursive:true,force:true});}
});

test('both SteamCMD success messages use the same result and checking phase',()=>{
  for(const [message,upToDate] of [["Success! App '343050' fully installed.",false],["Success! App '343050' already up to date.",true]]){
    assert.deepEqual(gameUpdateOutcome(message),{upToDate});
    const progress=new GameUpdateProgress();progress.consume('Update state downloading, progress: 50.00 (500 / 1000)\r',1000);
    progress.consume('\x1b[32m'+message+'\x1b[0m\r',2000);
    assert.equal(progress.snapshot().phase,'checking');assert.equal(progress.snapshot().progress,null);assert.equal(progress.snapshot().bytesPerSecond,null);
  }
  assert.equal(gameUpdateOutcome("Success! App '343051' already up to date."),null);
  assert.equal(gameUpdateOutcome('ERROR! Download failed'),null);
});

test('game version polling compares the Steam public build and keeps failures non-destructive',async()=>{
  assert.equal(installedGameBuild('"appid" "343050"\n"buildid" "25643504"'),'25643504');
  assert.equal(installedGameBuild('"appid" "322330"\n"buildid" "999"'),null);
  const checker=new GameVersionCheck({fetcher:async()=>new Response(JSON.stringify({data:{'343050':{depots:{branches:{public:{buildid:'25643505'}}}}}}))});
  const found=await checker.status('25643504');assert.equal(found.available,true);assert.equal(found.state,'available');assert.equal(found.latestBuild,'25643505');
  const current=await checker.status('25643505');assert.equal(current.available,false);assert.equal(current.state,'current');
  const unavailable=new GameVersionCheck({fetcher:async()=>{throw Error('offline')}});const result=await unavailable.status('25643504');assert.equal(result.available,null);assert.equal(result.state,'unavailable');
});

test('version metadata polling coalesces users, caches for fifteen minutes, and backs off failures',async()=>{
  let now=1000000,calls=0,resolveFetch;
  const checker=new GameVersionCheck({now:()=>now,fetcher:()=>{calls++;return new Promise(resolve=>resolveFetch=resolve)}});
  const first=checker.status('100'),second=checker.status('101');assert.equal(calls,1);
  resolveFetch(new Response(JSON.stringify({data:{'343050':{depots:{branches:{public:{buildid:'102'},updatebeta:{buildid:'999'}}}}}})));
  assert.equal((await first).available,true);assert.equal((await second).latestBuild,'102');
  await checker.status('102');assert.equal(calls,1);
  now+=15*60*1000;checker.fetcher=async()=>{calls++;throw Error('offline')};
  const stale=await checker.status('100');assert.equal(stale.stale,true);assert.equal(stale.available,true);assert.equal(stale.state,'unavailable');
  await checker.status('100');assert.equal(calls,2);
  now+=60000;await checker.status('100');assert.equal(calls,3);
  const ahead=await checker.status('103');assert.equal(ahead.available,false);
});

test('invalid or oversized version data never reports current or available',async()=>{
  for(const body of ['not json',JSON.stringify({data:{'343050':{depots:{branches:{updatebeta:{buildid:'999'}}}}}}),' '.repeat(131073)]){
    const checker=new GameVersionCheck({fetcher:async()=>new Response(body)});
    const status=await checker.status('100');assert.equal(status.available,null);assert.equal(status.latestBuild,null);assert.equal(status.state,'unavailable');
  }
});

test('game progress preserves split lines, calculates download throughput, and resets for validation',()=>{
  const progress=new GameUpdateProgress();
  progress.consume('Update state (0x61) downloading, progress: 12.',1000);
  assert.equal(progress.snapshot().progress,null);
  progress.consume('50 (125 / 1000)\r',1000);assert.equal(progress.snapshot().progress,12.5);
  progress.consume('Update state (0x61) downloading, progress: 50.00 (500 / 1000)\n',2000);
  assert.equal(progress.snapshot(2000).bytesPerSecond,375);assert.equal(progress.snapshot(9000).bytesPerSecond,null);
  progress.consume('Update state (0x5) validating, progress: 2.00 (20 / 1000)\r',3000);
  assert.equal(progress.snapshot().phase,'verifying');assert.equal(progress.snapshot().downloadedBytes,null);assert.equal(progress.snapshot().bytesPerSecond,null);
  for(let i=0;i<50;i++)progress.consume('line '+i+'\n',4000);
  assert.equal(progress.logs.length,30);
});

test('Steam percentage download lines expose bytes, speed and install stages',()=>{
  const progress=new GameUpdateProgress();
  progress.consume('[ 34%] Downloading update (14,428 of 41,429 KB)...\n',1000);
  assert.equal(progress.snapshot().phase,'downloading');
  assert.equal(progress.snapshot().progress,34);
  assert.equal(progress.snapshot().downloadedBytes,14428*1024);
  assert.equal(progress.snapshot().totalBytes,41429*1024);
  progress.consume('[ 35%] Downloading update (15,428 of 41,429 KB)...\n',2000);
  assert.equal(progress.snapshot(2000).bytesPerSecond,1024000);
  progress.consume('[----] Installing update...\n',3000);
  assert.equal(progress.snapshot().phase,'installing');
  assert.equal(progress.snapshot().downloadedBytes,null);
});
