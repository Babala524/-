import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {createPanel} from '../src/server.mjs';
import {AdminSessions,UploadGate,sameOrigin,safeEqual} from '../src/security.mjs';
import {Accounts} from '../src/accounts.mjs';

const secret='security-test-admin-secret-at-least-32';
const req=(headers={},method='GET')=>({headers,method,socket:{remoteAddress:'127.0.0.1',encrypted:false}});
async function fixture(run,options={}){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-security-'));
  const app=createPanel({data,game:path.join(data,'dst'),adminToken:secret,translationProvider:'off',...options});
  app.stopTimers();app.runtime.sessions=async()=>new Set();
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base='http://127.0.0.1:'+app.server.address().port;
  try{await run(app,base);}finally{app.server.closeAllConnections();app.close();fs.rmSync(data,{recursive:true,force:true});}
}

test('sessions are random, stored hashed, expire server-side and are individually revoked',async()=>fixture(app=>{
  let now=100000;const sessions=new AdminSessions(app.store,()=>now);
  const a=sessions.issue(req()),b=sessions.issue(req());assert.notEqual(a,b);
  const request=token=>req({cookie:'feather_session='+token});
  assert.equal(sessions.authenticated(request(a)),true);
  assert.equal(sessions.authenticated(request(b)),true);
  assert.ok(app.store.db.prepare('SELECT hash FROM admin_sessions').all().every(row=>!['a',a,b].includes(row.hash)));
  sessions.revoke(request(a));assert.equal(sessions.authenticated(request(a)),false);assert.equal(sessions.authenticated(request(b)),true);
  const old=crypto.createHmac('sha256',secret).update('feather-session-v1').digest('base64url');
  assert.equal(sessions.authenticated(request(old)),false);
  now+=12*3600000;assert.equal(sessions.authenticated(request(b)),false);
  assert.equal(sessions.authenticated(req({authorization:'Bearer '+secret})),true);
}));

test('sessions survive service restart and changing admin secret invalidates them',async()=>fixture(app=>{
  const first=new AdminSessions(app.store),cookie=first.issue(req()),request=req({cookie:'feather_session='+cookie});
  assert.equal(new AdminSessions(app.store).authenticated(request),true);
  const previous=app.store.adminToken;app.store.adminToken='another-secret-at-least-thirty-two-characters';
  assert.equal(new AdminSessions(app.store).authenticated(request),false);app.store.adminToken=previous;
}));

test('login limits use socket address, reject spoofed forwarded headers and cap memory',async()=>fixture(app=>{
  let now=100000;const sessions=new AdminSessions(app.store,()=>now);
  for(let i=0;i<10;i++)sessions.checkLogin(req({'x-forwarded-for':'192.0.2.'+i}));
  assert.throws(()=>sessions.checkLogin(req({'x-forwarded-for':'different'})),e=>e.status===429);
  now+=60000;assert.doesNotThrow(()=>sessions.checkLogin(req()));
  sessions.attempts=new Map(Array.from({length:10000},(_,i)=>['ip'+i,{start:now,count:1}]));
  assert.throws(()=>sessions.checkLogin(req()),e=>e.status===429);assert.equal(sessions.attempts.size,10000);
}));

test('origin checks reject different schemes, subdomains and opaque origins; upload slots release once',()=>{
  assert.equal(sameOrigin(req({host:'panel.example:80',origin:'http://panel.example'})),true);
  assert.equal(sameOrigin(req({host:'panel.example',origin:'https://panel.example'})),false);
  assert.equal(sameOrigin(req({host:'panel.example',origin:'null'})),false);
  assert.equal(sameOrigin(req({host:'panel.example',origin:'https://panel.example'}),true),true);
  assert.equal(sameOrigin(req({'sec-fetch-site':'same-site'},'POST')),false);
  assert.equal(sameOrigin(req({'sec-fetch-site':'cross-site'})),false);
  const gate=new UploadGate(2),release=gate.reserve(),other=gate.reserve();
  assert.throws(()=>gate.reserve(),e=>e.status===429);release();release();assert.equal(gate.active,1);other();assert.equal(gate.active,0);
  assert.equal(safeEqual('x'.repeat(1000),secret),false);
});

test('HTTP login, CSP, logout replay protection and malformed request validation',async()=>fixture(async(app,base)=>{
  const login=await fetch(base+'/login'),csp=login.headers.get('content-security-policy');
  assert.match(csp,/object-src 'none'/);assert.match(csp,/frame-ancestors 'none'/);assert.match(csp,/base-uri 'none'/);
  assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
  assert.match(await login.text(),/<script nonce="[^"]+">/);
  assert.equal(login.headers.get('cache-control'),'no-store');
  assert.match(login.headers.get('permissions-policy'),/camera=\(\)/);
  const post=body=>fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body});
  assert.equal((await post('null')).status,400);assert.equal((await post('[]')).status,400);
  let response=await post(JSON.stringify({token:secret}));assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(base+'/api/rooms',{headers:{cookie}})).status,200);
  response=await fetch(base+'/',{headers:{cookie}});assert.equal(response.status,200);
  const html=await response.text();assert.match(html,/<script nonce="[^\"]+" src="\/backend-client.js">/);assert.match(response.headers.get('content-security-policy'),/script-src-attr 'unsafe-hashes'/);
  assert.equal((await fetch(base+'/api/session',{method:'DELETE',headers:{cookie,origin:'https://attacker.example'}})).status,403);
  assert.equal((await fetch(base+'/api/session',{method:'DELETE',headers:{cookie}})).status,200);
  assert.equal((await fetch(base+'/api/rooms',{headers:{cookie}})).status,401);
  for(const route of ['/backend/src/server.mjs','/assets/../data/admin-token','/assets/%2e%2e%2fdata/admin-token']){
    const denied=await fetch(base+route,{headers:{Authorization:'Bearer '+secret}});assert.ok([400,404].includes(denied.status));
  }
}));

test('HTTP login rate limit returns retry header and HTTPS configuration marks cookies Secure',async()=>fixture(async(app,base)=>{
  const post=token=>fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
  const first=await post(secret);assert.match(first.headers.get('set-cookie'),/; Secure/);
  for(let i=0;i<9;i++)assert.equal((await post('incorrect')).status,401);
  const last=await post('incorrect');assert.equal(last.status,429);assert.equal(last.headers.get('retry-after'),'60');
},{secureCookies:true}));

test('first deployment can create a protected administrator and use account login',async()=>fixture(async(app,base)=>{
  const status=await fetch(base+'/api/account/status');assert.deepEqual((await status.json()).data,{setupRequired:true,registrationAllowed:false});
  const key=fs.readFileSync(path.join(app.config.data,'setup-key'),'utf8').trim();
  assert.equal((await fetch(base+'/api/account/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupKey:'x',username:'other',password:'correct horse battery staple'})})).status,401);
  let response=await fetch(base+'/api/account/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupKey:key,username:'面板管理员',password:'correct horse battery staple'})});
  assert.equal(response.status,201);const cookie=response.headers.get('set-cookie').split(';')[0];assert.equal(fs.existsSync(path.join(app.config.data,'setup-key')),false);
  response=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'面板管理员',password:'correct horse battery staple'})});assert.equal(response.status,200);
  const accountCookie=response.headers.get('set-cookie').split(';')[0];assert.equal((await fetch(base+'/api/account/me',{headers:{cookie:accountCookie}})).status,200);
  assert.equal((await fetch(base+'/api/account/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupKey:'x',username:'other',password:'correct horse battery staple'})})).status,409);
  assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'面板管理员',password:'wrong password'})})).status,401);
  assert.equal((await fetch(base+'/api/account/users',{headers:{cookie}})).status,200);
},{adminToken:secret}));

test('public registration cannot claim an uninitialized deployment',async()=>fixture(async(app,base)=>{
  const response=await fetch(base+'/api/account/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'first-user',password:'correct horse battery staple'})});
  assert.equal(response.status,403);assert.equal(app.accounts.hasUsers(),false);
},{allowRegistration:true}));

test('account records and account sessions persist across a service restart',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'feather-account-restart-'));
 const options={data,game:path.join(data,'dst'),adminToken:secret,translationProvider:'off'};
 let app=createPanel(options);app.stopTimers();
 try{
  const user=await app.accounts.setup({username:'RestartAdmin',password:'restart-persistent-password'},secret);
  const session=new AdminSessions(app.store).issue(req(),user.id);
  const encoded=app.store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id).password_hash;
  assert.match(encoded,/^scrypt\$/);assert.ok(!encoded.includes('restart-persistent-password'));
  app.close();app=createPanel(options);app.stopTimers();
  assert.equal(app.accounts.hasUsers(),true);assert.equal(fs.existsSync(path.join(data,'setup-key')),false);
  assert.equal((await app.accounts.authenticate('restartadmin','restart-persistent-password')).id,user.id);
  assert.equal(new AdminSessions(app.store).principal(req({cookie:'feather_session='+session})).userId,user.id);
 }finally{app.close();fs.rmSync(data,{recursive:true,force:true});}
});

test('concurrent first setup creates one administrator; duplicates and last-admin removal are rejected',async()=>fixture(async app=>{
 const input={username:'RaceAdmin',password:'race-safe-long-password'},key=app.accounts.setupKey();
 const results=await Promise.allSettled([app.accounts.setup(input,key),app.accounts.setup({...input,username:'RaceAdmin2'},key)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 const user=app.accounts.list()[0];assert.equal(app.accounts.list().length,1);
 await assert.rejects(app.accounts.create(user.username.toLowerCase(),input.password),e=>e.status===409);
 assert.throws(()=>app.accounts.remove(user.id),e=>e.status===409);
 assert.equal(new Accounts(app.store).hasUsers(),true);
}));

test('operator permissions, password changes and disabled-account session revocation are enforced',async()=>fixture(async(app,base)=>{
 const admin=await app.accounts.setup({username:'Owner',password:'owner-password-long'},secret);
 const operator=await app.accounts.create('Operator','operator-password-long');
 const sessions=new AdminSessions(app.store),cookie='feather_session='+sessions.issue(req(),operator.id);
 assert.equal((await fetch(base+'/api/rooms',{headers:{cookie}})).status,200);
 for(const [route,method] of [['/api/account/users','GET'],['/api/account/users','POST'],['/api/account/users/remove','POST'],['/api/mod-library/review','POST'],['/api/mod-library/unpublish','POST'],['/api/mod-library/remove','POST']]){
  assert.equal((await fetch(base+route,{method,headers:{cookie,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})})).status,403,route);
 }
 await assert.rejects(app.accounts.changePassword(operator.id,'new-operator-password','incorrect-current-password'),e=>e.status===401);
 await app.accounts.changePassword(operator.id,'new-operator-password','operator-password-long');
 assert.equal(sessions.authenticated(req({cookie})),false);
 assert.equal(await app.accounts.authenticate('Operator','operator-password-long'),null);
 assert.equal((await app.accounts.authenticate('Operator','new-operator-password')).id,operator.id);
 const otherCookie='feather_session='+sessions.issue(req(),operator.id);app.accounts.remove(operator.id);
 assert.equal(sessions.authenticated(req({cookie:otherCookie})),false);assert.equal(await app.accounts.authenticate('Operator','new-operator-password'),null);
 assert.equal(app.accounts.list().find(u=>u.id===admin.id).disabled,false);
}));

test('explicit public registration creates operators after owner setup; default registration stays closed',async()=>{
 await fixture(async(app,base)=>{
  const response=await fetch(base+'/api/account/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'visitor',password:'visitor-long-password'})});assert.equal(response.status,403);
 });
 await fixture(async(app,base)=>{
  await app.accounts.setup({username:'Owner',password:'owner-password-long'},secret);
  const response=await fetch(base+'/api/account/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'visitor',password:'visitor-long-password',role:'admin'})});
  assert.equal(response.status,201);const json=await response.json();assert.equal(json.user.role,'operator');assert.ok(!JSON.stringify(json).includes('password'));
 },{allowRegistration:true});
});
