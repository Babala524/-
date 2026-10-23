import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PlayerStats } from '../src/player-stats.mjs';

const first={userid:'KU_first-player',name:'玩家一',prefab:'wilson',world:'Master',playerage:42,localPlayer:true};
const second={userid:'KU_second-player',name:'玩家二',prefab:'wendy',world:'Caves',localPlayer:true};
const snapshot=(playerList,complete=true)=>({playerList,telemetry:{complete}});
function fixture(run){const db=new DatabaseSync(':memory:');try{run(new PlayerStats(db),db);}finally{db.close();}}

test('real online time accumulates once across duplicate shards and persists for offline players',()=>fixture(stats=>{
  stats.observe('0',snapshot([first,{...first,localPlayer:false,world:'Caves'}]),100000);
  stats.observe('0',snapshot([first,first,second]),115000);
  assert.equal(stats.ranking('0')[0].playSeconds,15);
  assert.equal(stats.ranking('0')[0].world,'Master');
  stats.observe('0',snapshot([second]),130000);
  assert.equal(stats.ranking('0').find(p=>p.userid===first.userid).playSeconds,15);
  stats.observe('0',snapshot([second]),145000);
  assert.equal(stats.ranking('0')[0].userid,second.userid);
  assert.equal(stats.ranking('0')[0].playSeconds,30);
  assert.equal(stats.ranking('0').length,2);
  assert.equal(stats.ranking('1').length,0);
}));

test('incomplete telemetry, long gaps and process restarts never count unobserved time',()=>fixture((stats,db)=>{
  stats.observe('0',snapshot([first]),100000);
  stats.observe('0',snapshot([first]),115000);
  stats.observe('0',snapshot([],false),130000);
  stats.observe('0',snapshot([first]),145000);
  assert.equal(stats.ranking('0')[0].playSeconds,15);
  stats.observe('0',snapshot([first]),300000);
  assert.equal(stats.ranking('0')[0].playSeconds,15);
  const restarted=new PlayerStats(db);
  restarted.observe('0',snapshot([first]),400000);
  assert.equal(restarted.ranking('0')[0].playSeconds,15);
  restarted.observe('0',snapshot([first]),415000);
  assert.equal(restarted.ranking('0')[0].playSeconds,30);
  assert.equal(restarted.started('0'),new Date(100000).toISOString());
}));

test('world migration updates character and identity without multiplying time; empty roles preserve the last known role',()=>fixture(stats=>{
  stats.observe('0',snapshot([first]),100000);
  stats.observe('0',snapshot([{...first,prefab:'wendy',world:'Caves',name:'新名字'}]),115000);
  stats.observe('0',snapshot([{userid:first.userid,name:'',world:'角色选择/世界迁移中'}]),130000);
  const [player]=stats.ranking('0');
  assert.equal(player.playSeconds,30);assert.equal(player.prefab,'wendy');assert.equal(player.name,'新名字');assert.equal(player.playerDays,42);
  assert.equal(player.lastSeen,new Date(130000).toISOString());
}));

test('missing telemetry is not an observation and invalid identifiers are ignored',()=>fixture(stats=>{
  stats.observe('0',{playerList:[first]},100000);
  assert.equal(stats.ranking('0').length,0);assert.equal(stats.started('0'),null);
  stats.observe('0',snapshot([{userid:'invalid'},first]),115000);
  assert.equal(stats.ranking('0').length,1);assert.equal(stats.ranking('0')[0].playSeconds,0);
}));
