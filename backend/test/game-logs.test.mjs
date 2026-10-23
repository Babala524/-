import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGameLog } from '../src/game-logs.mjs';
import { Runtime } from '../src/runtime.mjs';

function fixture(run) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'feather-log-')),file=path.join(folder,'server_log.txt');
  try { return run(file,folder); } finally { fs.rmSync(folder,{recursive:true,force:true}); }
}
const token='FP_0123456789abcdef0123';

test('filter console telemetry before taking the latest 500 useful game lines',()=>fixture(file=>{
  const useful=Array.from({length:620},(_,i)=>'[00:01:02]: 游戏日志 '+i);
  const noise=Array.from({length:1600},()=>'[00:01:03]: RemoteCommandInput: "--[[FEATHER_TELEMETRY]] local mapassets; '+ 'x'.repeat(200)+'"\n[00:01:03]: '+token+'\t{"kind":"state"}').join('\n');
  fs.writeFileSync(file,useful.join('\n')+'\n'+noise+'\n');
  const rows=readGameLog(file);
  assert.equal(rows.length,500);assert.equal(rows[0].message,'游戏日志 120');assert.equal(rows.at(-1).message,'游戏日志 619');
  assert.ok(rows.every(row=>row.time==='00:01:02'));
}));

test('hide current and legacy collection commands while preserving Lua failures, manual commands and chat',()=>fixture(file=>{
  fs.writeFileSync(file,[
    '[00:01:02]: RemoteCommandInput: "--[[FEATHER_TELEMETRY]] if TheWorld then local ma',
    '[00:01:02]: RemoteCommandInput: "if TheWorld and TheWorld.Map then local mapassets;local ok,ma=pcall(',
    '[00:01:02]: RemoteCommandInput: "local p={} for _,v in ipairs(GetPlayerClientTable() or {}) do',
    '[00:01:02]: RemoteCommandInput: "print(\\"'+token+'\\",json.encode({players=p}))"',
    '[00:01:02]: '+token+'\t{"kind":"mapasset","data":"616263"}',
    '[00:01:02]: RemoteCommandInput: "c_announce(\\"服务器将重启\\")"',
    '[00:01:02]: [string "scripts/mods.lua"]:123: attempt to index a nil value',
    'LUA ERROR stack traceback:',
    '    scripts/main.lua:42 in function OnUpdate',
    '玩家说 '+token+' 是什么？',
  ].join('\n'));
  const rows=readGameLog(file);assert.equal(rows.length,5);assert.match(rows[0].message,/c_announce/);
  assert.match(rows[1].message,/attempt to index/);assert.equal(rows[2].message,'LUA ERROR stack traceback:');
  assert.equal(rows[3].message,'    scripts/main.lua:42 in function OnUpdate');assert.match(rows[4].message,/玩家说/);
  fs.writeFileSync(file,'[00:01:02]: [Say] 玩家: '+token+'\tFEATHER_TELEMETRY');
  assert.equal(readGameLog(file,'chat').length,1);
}));

test('UTF-8 survives chunk boundaries; scan limits drop incomplete leading lines, and terminal controls disappear',()=>fixture(file=>{
  const lines=Array.from({length:20},(_,i)=>'[00:01:02]: 中文玩家你好 '+i);
  fs.writeFileSync(file,lines.join('\r\n')+'\r\n');
  const rows=readGameLog(file,'game',{chunkBytes:7});
  assert.deepEqual(rows.map(row=>row.message),lines.map(line=>line.slice(12)));
  const limited=readGameLog(file,'game',{chunkBytes:13,maxBytes:90});
  assert.ok(limited.length>0&&limited.length<20);assert.ok(limited.every(row=>row.message.startsWith('中文玩家你好 ')));
  fs.writeFileSync(file,'[00:01:02]: \x1b[31m模组错误\x1b[0m\x00\x07\r\n');
  assert.deepEqual(readGameLog(file),[{time:'00:01:02',message:'模组错误'}]);
  fs.writeFileSync(file,Buffer.concat([Buffer.from('[00:01:02]: 正在写入'),Buffer.from('中').subarray(0,2)]));
  assert.equal(readGameLog(file,'game',{chunkBytes:5})[0].message,'正在写入');
  assert.deepEqual(readGameLog(file+'-missing'),[]);
}));

test('runtime keeps each world and chat category separate without duplicating timestamp prefixes',()=>fixture((file,folder)=>{
  for (const world of ['Master','Caves']) {
    fs.mkdirSync(path.join(folder,world));
    fs.writeFileSync(path.join(folder,world,'server_log.txt'),'[00:01:02]: Simulation started\n');
    fs.writeFileSync(path.join(folder,world,'server_chat_log.txt'),'[00:01:03]: [Say] 玩家: 你好\n');
  }
  const store={getRoom:()=>({worlds:[{directory:'Master'},{directory:'Caves'}]}),cluster:()=>folder,db:{prepare:()=>({all:()=>[{time:'2026-10-21T00:00:00.000Z',message:'启动成功'}]})}};
  const {rows}=Runtime.prototype.logs.call({store},'0');
  assert.equal(rows.length,5);assert.equal(rows[0].world,'Master');assert.equal(rows[2].world,'Caves');
  assert.equal(rows[1].type,'chat');assert.equal(rows.at(-1).type,'system');assert.equal(rows[0].message,'Simulation started');
}));

test('log queries limit useful lines, isolate a world and retain worlds without logs',()=>fixture((file,folder)=>{
  const worlds=['Master','Caves','Caves2'];
  for(const world of worlds.slice(0,2)){
    fs.mkdirSync(path.join(folder,world));
    fs.writeFileSync(path.join(folder,world,'server_log.txt'),Array.from({length:600},(_,i)=>`[00:01:02]: ${world} 游戏 ${i}`).join('\n'));
    fs.writeFileSync(path.join(folder,world,'server_chat_log.txt'),'[00:01:03]: [Say] 你好');
  }
  let eventReads=0;
  const store={getRoom:()=>({worlds:worlds.map(directory=>({directory}))}),cluster:()=>folder,db:{prepare:()=>({all:()=>{eventReads++;return [{time:'2026-10-23',message:'系统记录'}];}})}};
  const runtime={store};
  const game=Runtime.prototype.logs.call(runtime,'0',{limit:100,world:'Caves',type:'game'});
  assert.equal(game.rows.length,100);assert.ok(game.rows.every(row=>row.world==='Caves'&&row.type==='game'));
  assert.equal(game.rows[0].message,'Caves 游戏 500');assert.equal(game.rows.at(-1).message,'Caves 游戏 599');assert.equal(eventReads,0);
  assert.deepEqual(game.worlds,worlds.map(directory=>({directory})));
  assert.equal(Runtime.prototype.logs.call(runtime,'0',{type:'game',limit:100}).rows.length,200);
  assert.equal(Runtime.prototype.logs.call(runtime,'0',{type:'game',world:'Caves2'}).rows.length,0);
  assert.equal(Runtime.prototype.logs.call(runtime,'0',{type:'game',world:'../Master'}).rows.length,0);
  assert.equal(Runtime.prototype.logs.call(runtime,'0',{type:'chat',world:'Master'}).rows.length,1);
  assert.deepEqual(Runtime.prototype.logs.call(runtime,'0',{type:'system'}).rows.map(row=>row.world),['面板']);
}));
