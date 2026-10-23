import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { configuration, Store, Fault, demand, inside, identifier, modID } from './core.mjs';
import { Rooms } from './rooms.mjs';
import { Runtime } from './runtime.mjs';
import { Saves } from './saves.mjs';
import { Mods } from './mods.mjs';
import { Lobby } from './lobby.mjs';
import { Players } from './players.mjs';
import { Announcements } from './announcements.mjs';
import { ModUpdates } from './mod-updates.mjs';
import { packageLimit } from './mod-library.mjs';
import { AdminSessions, UploadGate, safeEqual, sameOrigin, sessionCookie, securityHeaders, secureHTML } from './security.mjs';
import { Accounts } from './accounts.mjs';
import {ensureNative} from './native-dependencies.mjs';

async function uploadedPackage(req,config,operation,uploads) {
  const size=Number(req.headers['content-length']);demand(Number.isSafeInteger(size)&&size>0&&size<=packageLimit,'模组 ZIP 为空或超过 512 MB',413);
  demand((req.headers['content-type']||'').split(';')[0]==='application/zip','只接受 ZIP 模组包',415);
  const temp=inside(config.data,'tmp/mod-upload-'+crypto.randomUUID()+'.zip'),release=uploads.reserve();let received=0;
  try{fs.mkdirSync(path.dirname(temp),{recursive:true});await pipeline(Readable.from((async function*(){for await(const chunk of req){received+=chunk.length;demand(received<=size,'模组上传超过声明大小',413);yield chunk;}})()),fs.createWriteStream(temp,{flags:'wx',mode:0o600}));demand(received===size,'上传文件不完整');return await operation(temp);}
  finally{try{fs.rmSync(temp,{force:true});}finally{release();}}
}

async function bodyJSON(req) {
  demand((req.headers['content-type']||'').startsWith('application/json'),'需要 application/json',415);
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;demand(size<=2097152,'请求内容过大',413);chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Fault(400,'JSON 格式不合法');}
  demand(value&&typeof value==='object'&&!Array.isArray(value),'请求内容必须为 JSON 对象');return value;
}
function send(res,status,data) {
  const source=Buffer.from(JSON.stringify(data));
  const acceptsGzip=/\bgzip\b/i.test(res.req?.headers?.['accept-encoding']||'');
  const body=acceptsGzip&&source.length>=8192?zlib.gzipSync(source,{level:6}):source;
  const headers={'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(body!==source){headers['Content-Encoding']='gzip';headers.Vary='Accept-Encoding';}
  res.writeHead(status,headers);res.end(body);
}
function asciiSafeScript(source){
  return String(source).replace(/[^\x00-\x7F]/gu, char => {
    const codePoint=char.codePointAt(0);
    if(codePoint<=0xffff)return `\\u${codePoint.toString(16).padStart(4,'0')}`;
    const value=codePoint-0x10000;
    const high=0xd800+(value>>10);
    const low=0xdc00+(value&0x3ff);
    return `\\u${high.toString(16)}\\u${low.toString(16)}`;
  });
}
function asciiSafeHtml(source){
  const text=String(source);
  let out='',cursor=0;
  const scriptPattern=/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
  for(const match of text.matchAll(scriptPattern)){
    out += htmlAscii(text.slice(cursor,match.index));
    const block=match[0], openEnd=block.indexOf('>')+1, closeStart=block.toLowerCase().lastIndexOf('</script');
    out += block.slice(0,openEnd)+asciiSafeScript(block.slice(openEnd,closeStart))+block.slice(closeStart);
    cursor=match.index+block.length;
  }
  out += htmlAscii(text.slice(cursor));
  return out;
}
function htmlAscii(source){
  return String(source).replace(/[^\x00-\x7F]/gu, char => `&#x${char.codePointAt(0).toString(16)};`);
}
const loginHTML=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FeatherPanel 登录</title><style>:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#382832;background:#fff1f5}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;box-sizing:border-box}.card{box-sizing:border-box;background:#fff;padding:32px;width:min(420px,100%);border-radius:22px;box-shadow:0 18px 60px #ce749333}h2{margin:0 0 8px;font-size:24px}p{font-size:13px;line-height:1.7;color:#78616c}.tabs{display:flex;gap:8px;margin:20px 0 4px;flex-wrap:wrap}.tabs button{width:auto;margin:0;padding:8px 12px;background:#fff;color:#8b5364;border:1px solid #e5ced8}.tabs button.active{background:#df3155;color:#fff;border-color:#df3155}label{display:block;margin-top:14px;font-size:13px;font-weight:600}input,.submit{box-sizing:border-box;width:100%;padding:13px;border-radius:10px;border:1px solid #e5ced8;margin-top:7px;font:inherit}.submit{margin-top:20px;background:#df3155;color:#fff;cursor:pointer;border:0;font-weight:700}.hint{font-size:12px;color:#9a7180}.error{min-height:20px;color:#c32048}.setup{display:none;border-top:1px solid #f0dfe5;margin-top:18px;padding-top:10px}.setup>button{border:0;background:none;color:#c32048;cursor:pointer;padding:0;font:inherit}.setup form{margin-top:8px}</style><main class="card"><h2>绯羽 FeatherPanel</h2><p id="intro">使用账号密码登录面板。</p><div class="tabs"><button type="button" id="accountTab" class="active">账号登录</button><button type="button" id="registerTab" hidden>注册账号</button><button type="button" id="tokenTab">管理员密钥</button></div><form id="accountForm"><label for="username">用户名</label><input id="username" autocomplete="username" required><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" required><button class="submit">登录面板</button></form><form id="registerForm" hidden><label for="registerUser">用户名</label><input id="registerUser" autocomplete="username"><label for="registerPass">密码（至少 10 位）</label><input id="registerPass" type="password" autocomplete="new-password"><button class="submit">注册并登录</button></form><form id="tokenForm" hidden><label for="token">管理员密钥</label><input id="token" type="password" autocomplete="current-password"><button class="submit">登录面板</button></form><section id="setup" class="setup"><button type="button" id="setupToggle">首次部署？创建管理员账号</button><form id="setupForm" hidden><label for="setupKey">初始化密钥 / 原管理员密钥</label><input id="setupKey" type="password" autocomplete="off"><label for="setupUser">管理员用户名</label><input id="setupUser" autocomplete="username"><label for="setupPass">管理员密码（至少 10 位）</label><input id="setupPass" type="password" autocomplete="new-password"><button class="submit">创建并登录</button></form></section><p id="setupHint" class="hint" hidden>Docker：读取 /data/setup-key；原生部署：运行 sudo featherpanel key。升级用户也可使用原管理员密钥创建账号。</p><p id="error" class="error" role="alert"></p></main><script>(async()=>{const accountTab=document.getElementById('accountTab'),registerTab=document.getElementById('registerTab'),tokenTab=document.getElementById('tokenTab'),accountForm=document.getElementById('accountForm'),registerForm=document.getElementById('registerForm'),tokenForm=document.getElementById('tokenForm'),setup=document.getElementById('setup'),setupToggle=document.getElementById('setupToggle'),setupForm=document.getElementById('setupForm'),error=document.getElementById('error'),hint=document.getElementById('setupHint');const show=mode=>{for(const [button,form] of [[accountTab,accountForm],[registerTab,registerForm],[tokenTab,tokenForm]]){const active=mode===button;button.classList.toggle('active',active);form.hidden=!active;}};accountTab.onclick=()=>show(accountTab);registerTab.onclick=()=>show(registerTab);tokenTab.onclick=()=>show(tokenTab);setupToggle.onclick=()=>{setupForm.hidden=!setupForm.hidden;};try{const r=await fetch('/api/account/status');const status=await r.json();if(status.data?.setupRequired){setup.style.display='block';hint.hidden=false;}if(status.data?.registrationAllowed)registerTab.hidden=false;}catch{};const submit=async(body,url='/api/session')=>{error.textContent='';const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const detail=await r.json().catch(()=>null);if(!r.ok)throw Error(detail?.error||'操作失败，请检查输入');location.href='/';};accountForm.onsubmit=async e=>{e.preventDefault();try{await submit({username:document.getElementById('username').value,password:document.getElementById('password').value});}catch(e){error.textContent=e.message;}};registerForm.onsubmit=async e=>{e.preventDefault();try{await submit({username:document.getElementById('registerUser').value,password:document.getElementById('registerPass').value},'/api/account/register');}catch(e){error.textContent=e.message;}};tokenForm.onsubmit=async e=>{e.preventDefault();try{await submit({token:document.getElementById('token').value.trim()});}catch(e){error.textContent=e.message;}};setupForm.onsubmit=async e=>{e.preventDefault();try{await submit({setupKey:document.getElementById('setupKey').value.trim(),username:document.getElementById('setupUser').value,password:document.getElementById('setupPass').value},'/api/account/setup');}catch(e){error.textContent=e.message;}};})();</script></html>`;

export function createPanel(overrides={}) {
  const config=configuration(overrides),store=new Store(config),accounts=new Accounts(store),runtime=new Runtime(store),rooms=new Rooms(store,runtime),mods=new Mods(store,runtime),saves=new Saves(store,runtime,mods),players=new Players(store,runtime);
  const lobby=new Lobby(store),sessions=new AdminSessions(store),uploads=new UploadGate(); let installing=false;
  const announcements=new Announcements(store,runtime);
  const modUpdates=new ModUpdates(store,mods);
  runtime.applyModUpdates=()=>mods.applyPending();
  const server=http.createServer(async(req,res)=>{
    securityHeaders(res);
    try{
      const url=new URL(req.url,'http://localhost'),route=url.pathname,method=req.method;
      if(route==='/healthz'&&method==='GET'){send(res,200,{ok:true,service:'FeatherPanel'});return;}
      if(route.startsWith('/registry/v1/')){
        demand(config.modRegistryHost,'本面板未托管共享库',404);
        const action=route.slice('/registry/v1/'.length);
        if(action==='mods'&&method==='GET'){send(res,200,{data:mods.library.publicList(Object.fromEntries(url.searchParams))});return;}
        if(/^mods\/\d{6,20}$/.test(action)&&method==='GET'){send(res,200,{data:mods.library.publicEntry(action.slice(5))});return;}
        if(/^icons\/[a-f0-9]{64}\.png$/.test(action)&&method==='GET'){const hash=action.slice(6,-4);mods.library.publicPackage(hash);const file=mods.library.icon(hash);demand(fs.existsSync(file),'模组图标不存在',404);res.writeHead(200,{'Content-Type':'image/png','Content-Length':fs.statSync(file).size,'Cache-Control':'public, max-age=3600'});await pipeline(fs.createReadStream(file),res);return;}
        if(/^packages\/[a-f0-9]{64}\.zip$/.test(action)&&method==='GET'){
          const hash=action.slice(9,-4),file=mods.library.publicPackage(hash);res.writeHead(200,{'Content-Type':'application/zip','Content-Length':fs.statSync(file).size,'Cache-Control':'public, max-age=3600','Content-Disposition':`attachment; filename="${hash}.zip"`});await pipeline(fs.createReadStream(file),res);return;
        }
        if(action==='submissions'&&method==='POST'){
          const release=mods.library.reserve(req.socket.remoteAddress);
          try{let metadata;try{const header=req.headers['x-feather-mod'];demand(typeof header==='string'&&header.length<=8192,'模组信息过大');metadata=JSON.parse(Buffer.from(header,'base64url').toString('utf8'));}catch{throw new Fault(400,'提交的模组信息不合法');}
            send(res,202,{data:await uploadedPackage(req,config,file=>mods.library.accept(file,metadata),uploads)});
          }finally{release();}return;
        }
        throw new Fault(404,'共享库接口不存在');
      }
      if(route==='/login'&&method==='GET'){const html=secureHTML(res,asciiSafeHtml(loginHTML),loginHTML);res.writeHead(200,{'Content-Type':'text/html; charset=UTF-8','Content-Language':'zh-CN','Cache-Control':'no-store'});res.end(html);return;}
      if(route==='/api/account/status'&&method==='GET'){send(res,200,{data:accounts.publicStatus()});return;}
      demand(sameOrigin(req,config.secureCookies),'不接受跨站请求',403);
      if(route==='/api/session'&&method==='POST'){
        try{sessions.checkLogin(req);}catch(error){if(error.status===429)res.setHeader('Retry-After','60');throw error;}
        const input=await bodyJSON(req);let user=null;
        if(typeof input.token==='string'&&safeEqual(input.token,store.adminToken)) user={role:'admin',username:'管理员',id:null};
        else if(typeof input.username==='string'&&typeof input.password==='string') user=await accounts.authenticate(input.username,input.password);
        demand(user,'用户名或密码不正确',401);
        res.setHeader('Set-Cookie',sessionCookie(sessions.issue(req,user.id),config.secureCookies||req.socket.encrypted));send(res,200,{ok:true,user:{username:user.username,role:user.role}});return;
      }
      if(route==='/api/account/setup'&&method==='POST'){try{sessions.checkLogin(req);}catch(error){if(error.status===429)res.setHeader('Retry-After','60');throw error;}const input=await bodyJSON(req),user=await accounts.setup(input,String(input.setupKey||input.authorization||''));res.setHeader('Set-Cookie',sessionCookie(sessions.issue(req,user.id),config.secureCookies||req.socket.encrypted));send(res,201,{ok:true,user});return;}
      if(route==='/api/account/register'&&method==='POST'){demand(config.allowRegistration,'管理员未开放自助注册',403);demand(accounts.hasUsers(),'请先由管理员完成首次初始化',403);try{sessions.checkLogin(req);}catch(error){if(error.status===429)res.setHeader('Retry-After','60');throw error;}const input=await bodyJSON(req),user=await accounts.create(input.username,input.password,'operator');res.setHeader('Set-Cookie',sessionCookie(sessions.issue(req,user.id),config.secureCookies||req.socket.encrypted));send(res,201,{ok:true,user});return;}
      if(!sessions.authenticated(req)){
        if(route.startsWith('/api/'))throw new Fault(401,'请先登录');
        res.writeHead(302,{Location:'/login'});res.end();return;
      }
      const principal=sessions.principal(req);
      if(route==='/api/environment/prepare'&&method==='POST'){
        demand(config.nativeDependencies,'此部署不需要准备原生环境',409);
        const input=await bodyJSON(req);demand(['python','map','game'].includes(input.group),'未知依赖类型');
        send(res,202,{data:store.task('准备运行环境','0',async report=>{await ensureNative(config,input.group,report);return {ready:true};})});return;
      }
      if(route==='/api/session'&&method==='DELETE'){sessions.revoke(req);res.setHeader('Set-Cookie',sessionCookie('',config.secureCookies||req.socket.encrypted));send(res,200,{ok:true});return;}
      if(route==='/api/account/me'&&method==='GET'){send(res,200,{data:principal});return;}
      if(route==='/api/account/password'&&method==='PUT'){demand(principal?.kind==='account','账号会话才可修改密码',403);sessions.checkLogin(req);const input=await bodyJSON(req);send(res,200,{data:await accounts.changePassword(principal.userId,input.password,input.currentPassword)});return;}
      if(route==='/api/account/users'&&method==='GET'){demand(principal?.role==='admin','只有管理员可以查看账号',403);send(res,200,{data:accounts.list()});return;}
      if(route==='/api/account/users'&&method==='POST'){demand(principal?.role==='admin','只有管理员可以创建账号',403);sessions.checkLogin(req);const input=await bodyJSON(req);send(res,201,{data:await accounts.create(input.username,input.password,input.role||'operator')});return;}
      if(route==='/api/account/users/remove'&&method==='POST'){demand(principal?.role==='admin','只有管理员可以停用账号',403);const input=await bodyJSON(req);send(res,200,{data:accounts.remove(input.id)});return;}
      if(route==='/api/rooms'&&method==='GET'){send(res,200,{data:store.rooms().map(room=>({id:room.id,name:room.name}))});return;}
      if(route==='/api/inbox'&&method==='GET'){send(res,200,{data:modUpdates.list()});return;}
      if(route==='/api/inbox/read'&&method==='POST'){const input=await bodyJSON(req);send(res,200,{data:modUpdates.markRead(input.through)});return;}
      if(route==='/api/workshop/auto-update'&&method==='PUT'){const input=await bodyJSON(req);send(res,200,{data:modUpdates.configure(input.enabled)});return;}
      if(route==='/api/workshop/auto-update/check'&&method==='POST'){demand(!modUpdates.busy&&!store.sharedBusy&&!store.locks.size&&!mods.jobs.size,'有操作进行中，请稍后检查',409);send(res,202,{data:store.task('检查模组更新','0',()=>modUpdates.tick(Date.now(),true))});return;}
      if(route.startsWith('/api/tasks/')&&method==='GET'){send(res,200,{data:store.getTask(route.slice(11))});return;}
      if(route==='/api/game/status'&&method==='GET'){send(res,200,{data:await runtime.gameUpdateCheck()});return;}
      if(route==='/api/game/update/cancel'&&method==='POST'){
        demand(installing&&store.sharedBusy,'当前没有正在进行的游戏更新',409);
        demand(runtime.cancelGameUpdate(),'正在准备运行环境，请等待完成后再终止游戏下载',409);
        send(res,202,{data:{cancelled:true}});return;
      }
      if((route==='/api/game/install'||route==='/api/game/update')&&method==='POST'){
        const updating=route==='/api/game/update';
        const input=req.headers['content-type']?await bodyJSON(req):{};demand(input&&typeof input==='object'&&!Array.isArray(input)&&(input.validate===undefined||typeof input.validate==='boolean'),'校验选项必须为布尔值');
        demand(!installing&&!store.sharedBusy&&!store.locks.size&&!mods.jobs.size,'有游戏或模组操作进行中，请稍后安装或更新',409);installing=true;store.sharedBusy=true;
        send(res,202,{data:store.task(updating?'更新游戏':'安装游戏','0',async report=>{try{report(null,'正在检查所有世界是否已关闭',{phase:'preparing'});for(const room of store.rooms())demand(!(await runtime.status(room.id)).some(world=>world.running),(updating?'更新':'安装')+'前请先关闭所有房间',409);return await runtime.install(report,{validate:!updating||input.validate===true});}finally{installing=false;store.sharedBusy=false;}})});return;
      }
      if(route==='/api/workshop/downloads'&&method==='GET'){send(res,200,{data:mods.downloads()});return;}
      if(route==='/api/mod-library'&&method==='GET'){send(res,200,{data:mods.library.status()});return;}
      if(/^\/api\/mod-library\/community-icons\/[a-f0-9]{64}\.png$/.test(route)&&method==='GET'){const image=await mods.library.remoteIcon(route.split('/').pop().slice(0,-4));res.writeHead(200,{'Content-Type':'image/png','Content-Length':image.length,'Cache-Control':'private, max-age=3600'});res.end(image);return;}
      if(/^\/api\/mod-library\/icons\/[a-f0-9]{64}\.png$/.test(route)&&method==='GET'){const file=mods.library.icon(route.split('/').pop().slice(0,-4));demand(fs.existsSync(file),'模组图标不存在',404);res.writeHead(200,{'Content-Type':'image/png','Content-Length':fs.statSync(file).size,'Cache-Control':'private, max-age=3600'});await pipeline(fs.createReadStream(file),res);return;}
      if(route==='/api/mod-library/submit'&&method==='POST'){const input=await bodyJSON(req);send(res,200,{data:await mods.library.submit(input.id,input.consent)});return;}
      if(route==='/api/mod-library/review'&&method==='POST'){demand(principal?.role==='admin','只有管理员可以审核共享模组',403);const input=await bodyJSON(req);demand(typeof input.publish==='boolean','审核操作不合法');send(res,200,{data:mods.library.review(input.hash,input.publish)});return;}
      if(route==='/api/mod-library/unpublish'&&method==='POST'){demand(principal?.role==='admin','只有管理员可以取消发布共享模组',403);const input=await bodyJSON(req);send(res,200,{data:mods.library.unpublish(input.id)});return;}
      if(route==='/api/mod-library/remove'&&method==='POST'){demand(principal?.role==='admin','只有管理员可以移除共享模组',403);const input=await bodyJSON(req);demand(!mods.jobs.size&&!store.sharedBusy&&!store.locks.size,'有操作进行中，请稍后移除收录',409);send(res,200,{data:mods.library.removeLocal(input.id)});return;}
      if(/^\/api\/mod-library\/packages\/[a-f0-9]{64}\.zip$/.test(route)&&method==='GET'){const file=mods.library.package(route.split('/').pop().slice(0,-4));demand(fs.existsSync(file),'模组包不存在',404);res.writeHead(200,{'Content-Type':'application/zip','Content-Length':fs.statSync(file).size,'Content-Disposition':'attachment; filename="mod-review.zip"','Cache-Control':'no-store'});await pipeline(fs.createReadStream(file),res);return;}
      if(route==='/api/workshop/search'&&method==='POST'){send(res,200,{data:await mods.search(await bodyJSON(req))});return;}
      if(route==='/api/workshop/details'&&method==='POST'){const input=await bodyJSON(req);send(res,200,{data:await mods.details(input.ids)});return;}
      const match=route.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,80})(?:\/(.*))?$/);
      if(match){
        const id=identifier(match[1]),action=match[2]||'';
        if(!action&&method==='GET'){send(res,200,{data:rooms.public(store.getRoom(id))});return;}
        if(!action&&method==='PUT'){demand(!installing,'游戏更新中，请稍后保存',409);send(res,200,{data:await rooms.save(id,await bodyJSON(req))});return;}
        if(action==='status'&&method==='GET'){send(res,200,{data:await runtime.overview(id)});return;}
        if(action==='worlds'&&method==='GET'){store.getRoom(id);send(res,200,{data:await runtime.worldStatus(id)});return;}
        if(action==='worlds/control'&&method==='POST'){
          const input=await bodyJSON(req);demand(['start','stop'].includes(input.action),'未知世界操作');demand(!installing,'游戏更新中，请稍后操作',409);
          rooms.worldTarget(id,input.worldID);
          send(res,202,{data:store.task((input.action==='start'?'启动':'关闭')+'世界 '+input.worldID,id,()=>rooms.controlWorld(id,input.worldID,input.action))});return;
        }
        if(action==='map'&&method==='GET'){
          const worldID=url.searchParams.get('world')||'';
          const quality=url.searchParams.get('quality')==='preview'?'preview':'full';
          if(url.searchParams.get('refresh')==='1')runtime.telemetry.invalidate(id,worldID);
          send(res,200,{data:await runtime.mapPreview(id,worldID,{quality})});return;
        }
        if(action==='logs'&&method==='GET'){
          const rawLimit=Number(url.searchParams.get('limit')||500);
          const limit=Number.isInteger(rawLimit)?Math.max(50,Math.min(5000,rawLimit)):500;
          send(res,200,{data:runtime.logs(id,{limit,world:url.searchParams.get('world')||'',type:url.searchParams.get('type')||''})});return;
        }
        if(action==='announcement'&&method==='POST'){send(res,200,{data:await announcements.send(id)});return;}
        if(action==='players'&&method==='GET'){send(res,200,{data:await players.overview(id)});return;}
        if(action==='players/list'&&method==='POST'){const input=await bodyJSON(req);demand(input.enabled===undefined||typeof input.enabled==='boolean','名单操作必须为布尔值');const kind=String(input.kind);send(res,200,{data:kind==='whitelist'?await players.setWhitelist(id,input.userid,input.enabled!==false):players.set(id,kind,input.userid,input.enabled!==false)});return;}
        if(action==='players/kick'&&method==='POST'){const input=await bodyJSON(req);send(res,202,{data:store.task('移出玩家',id,report=>store.locked(id,()=>players.kick(id,input.userid,report)))});return;}
        if(action==='saves'&&method==='GET'){send(res,200,{data:saves.list(id)});return;}
        if(action==='saves/download'&&method==='GET'){
          const {entry,file}=saves.download(id,url.searchParams.get('saveID')||'');
          const filename=(entry.name||'backup').replace(/[\\/:*?"<>|\r\n]+/g,'_').slice(0,120)||'backup';
          res.statusCode=200;res.setHeader('Content-Type','application/zip');res.setHeader('Content-Length',fs.statSync(file).size);res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}.zip"`);res.setHeader('Cache-Control','no-store');await pipeline(fs.createReadStream(file),res);return;
        }
        if(action==='saves/delete'&&method==='POST'){
          const input=await bodyJSON(req);send(res,200,{data:await store.locked(id,()=>saves.remove(id,input.saveIDs))});return;
        }
        if(action==='saves/restore'&&method==='POST'){
          const input=await bodyJSON(req);send(res,202,{data:store.task('恢复存档',id,(report)=>store.locked(id,()=>saves.restore(id,String(input.saveID),report)))});return;
        }
        if(action==='snapshots'&&method==='GET'){send(res,200,{data:{rows:saves.snapshots(id).map(({relative,sequence,...row})=>row)}});return;}
        if(action==='mods'&&method==='GET'){send(res,200,{data:await mods.installed(id,url.searchParams.get('updates')==='1')});return;}
        if(action==='mods/upload'&&method==='POST'){
          store.getRoom(id);demand(!installing&&!store.sharedBusy&&!mods.jobs.size&&!store.locks.size,'有操作进行中，请稍后上传模组',409);
          const mod=modID(url.searchParams.get('id')),filename=url.searchParams.get('filename')||'';demand(/\.zip$/i.test(filename),'请选择单个模组的 ZIP 包');
          const result=await uploadedPackage(req,config,file=>store.locked(id,()=>mods.library.remember(file,mod,{name:url.searchParams.get('name')})),uploads);
          send(res,202,{data:mods.enqueue(id,result.id)});return;
        }
        if(action==='mods/collect'&&method==='POST'){
          const input=await bodyJSON(req);store.getRoom(id);demand(!installing&&!store.sharedBusy&&!mods.jobs.size&&!store.locks.size,'有操作进行中，请稍后收录',409);
          const folder=mods.find(input.id);demand(folder,'该模组尚未安装',404);
          send(res,200,{data:await store.locked(id,()=>mods.library.capture(input.id,folder))});return;
        }
        if(action==='mods/config'&&method==='POST'){const input=await bodyJSON(req);send(res,200,{data:mods.configFields(id,input.modID,{retry:input.retryTranslation===true})});return;}
        if(action==='control'&&method==='POST'){
          const input=await bodyJSON(req);demand(['start','stop','restart','rollback','reset','check'].includes(input.action),'未知游戏操作');demand(!installing,'游戏更新中，请稍后操作',409);
          if(input.action==='check'){send(res,200,{data:await lobby.check(id)});return;}
          store.getRoom(id);
          if(['start','restart'].includes(input.action)){
            send(res,202,{data:store.task('游戏'+input.action,id,()=>rooms.control(id,input.action,input.mods))});return;
          }
          send(res,202,{data:store.task('游戏'+input.action,id,()=>store.locked(id,()=>input.action==='rollback'?runtime.rollback(id,input.days):runtime[input.action](id)))});return;
        }
        if(action==='saves/backup'&&method==='POST'){store.getRoom(id);send(res,202,{data:store.task('立即备份',id,()=>store.locked(id,()=>saves.backup(id)))});return;}
        if(action==='snapshots/restore'&&method==='POST'){
          const input=await bodyJSON(req);store.getRoom(id);
          send(res,202,{data:store.task('恢复快照',id,()=>store.locked(id,()=>saves.restoreSnapshot(id,String(input.snapshotID),String(input.worldID))))});return;
        }
        if(action==='saves/upload'&&method==='POST'){
          store.getRoom(id);
          // The browser service accepts File; transport streams raw archive bytes to avoid buffering multipart payloads.
          const size=Number(req.headers['content-length']);demand(Number.isSafeInteger(size)&&size>0&&size<=config.uploadLimit,'文件为空或超过上传大小限制',413);
          const original=url.searchParams.get('filename')||'',name=(url.searchParams.get('name')||original).slice(0,160);
          demand(/\.(zip|tar\.gz|tgz)$/i.test(original),'只接受 ZIP、TAR.GZ 或 TGZ 存档包');
          const temp=inside(config.data,'tmp/upload-'+crypto.randomUUID()+(/\.zip$/i.test(original)?'.zip':'.tgz'));fs.mkdirSync(path.dirname(temp),{recursive:true});
          let received=0;const release=uploads.reserve();
          try{
            await pipeline(Readable.from((async function*(){for await(const chunk of req){received+=chunk.length;demand(received<=size&&received<=config.uploadLimit,'上传超过声明大小或限制',413);yield chunk;}})()),fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
            demand(received===size,'上传文件不完整');
            send(res,200,{data:await store.locked(id,()=>saves.upload(id,temp,name))});
          }finally{try{fs.rmSync(temp,{force:true});}finally{release();}}return;
        }
        if(['mods/download','mods/update','mods/delete'].includes(action)&&method==='POST'){
          const input=await bodyJSON(req);store.getRoom(id);demand(!installing,'游戏更新中，请稍后管理模组',409);
          const deleting=action==='mods/delete';
          send(res,202,{data:deleting?store.task('删除模组',id,()=>store.locked(id,()=>mods.remove(id,input.id))):mods.enqueue(id,input.id,{source:input.source,hash:input.hash,workshop:action==='mods/update'})});return;
        }
      }
      if(route.startsWith('/api/'))throw new Fault(404,'接口不存在');
      demand(method==='GET'||method==='HEAD','不支持的请求方式',405);
      let relative;try{relative=decodeURIComponent(route.slice(1))||'index.html';}catch{throw new Fault(400,'路径编码不合法');}
      const allowed=relative==='index.html'||relative==='wallpaper.mp4'||relative==='backend-client.js'||relative.startsWith('assets/');
      demand(allowed,'文件不存在',404);const file=inside(config.root,relative);demand(fs.existsSync(file)&&fs.statSync(file).isFile(),'文件不存在',404);
      const stat=fs.statSync(file),mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mp4':'video/mp4','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp'}[path.extname(file)]||'application/octet-stream';
      res.setHeader('Content-Type',mime);res.setHeader('Content-Language','zh-CN');res.setHeader('Cache-Control','no-cache');
      if(relative==='index.html'){
        const roomID=url.searchParams.get('room')||'0';let initial={room:null,overview:null};
        try{initial={room:rooms.public(store.getRoom(roomID)),overview:await runtime.overview(roomID)};}catch(error){if(error.status!==404)throw error;}
        initial.nativeDependencies=config.nativeDependencies;
        const state=JSON.stringify(initial).replace(/</g,'\\u003c');
        const template=fs.readFileSync(file,'utf8');
        const html=template.replace('</body>',`<script>window.featherPanelInitialState=${state};</script><script src="/backend-client.js"></script>\n</body>`);
        const encoded=secureHTML(res,asciiSafeHtml(html),template);
        res.setHeader('Content-Length',Buffer.byteLength(encoded));res.end(method==='HEAD'?undefined:encoded);return;
      }
      let start=0,end=stat.size-1;
      if(req.headers.range){const range=req.headers.range.match(/^bytes=(\d+)-(\d*)$/);demand(range,'范围请求不合法',416);start=Number(range[1]);end=range[2]?Number(range[2]):end;demand(start<=end&&end<stat.size,'范围请求超出文件',416);res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`);}
      res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',end-start+1);
      if(method==='HEAD'){res.end();return;}
      if(path.extname(file)==='.js'&&start===0&&end===stat.size-1){
        const source=asciiSafeScript(fs.readFileSync(file,'utf8'));res.setHeader('Content-Length',Buffer.byteLength(source));res.end(source);return;
      }
      await pipeline(fs.createReadStream(file,{start,end}),res);
    }catch(error){if(!res.headersSent)send(res,error.status||500,{error:error.status?error.message:'服务器操作失败，请检查后端日志'});else res.destroy();if(!error.status)console.error(error.message);}
  });
  server.requestTimeout=180000;server.headersTimeout=30000;
  server.maxHeadersCount=100;server.maxRequestsPerSocket=1000;
  const interval=setInterval(()=>saves.tick().catch(error=>console.error('Scheduler:',error.message)),15000);interval.unref();
  let tracking=false;
  const playerInterval=setInterval(async()=>{if(tracking)return;tracking=true;try{await players.tick();}finally{tracking=false;}},15000);playerInterval.unref();
  const announcementInterval=setInterval(()=>announcements.tick().catch(error=>console.error('Announcements:',error.message)),15000);announcementInterval.unref();
  const modUpdateInterval=setInterval(()=>modUpdates.tick().catch(error=>console.error('Mod updates:',error.message)),60000);modUpdateInterval.unref();
  const stopTimers=()=>{clearInterval(interval);clearInterval(playerInterval);clearInterval(announcementInterval);clearInterval(modUpdateInterval);};
  return {server,store,accounts,runtime,rooms,saves,mods,lobby,players,announcements,modUpdates,config,stopTimers,close:()=>{stopTimers();mods.translation.close();server.close();store.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href){
  const app=createPanel();
  app.server.listen(app.config.port,app.config.host,()=>console.log(`FeatherPanel listening on ${app.config.host}:${app.config.port}; administrator secret is stored in FEATHER_DATA/admin-token when not supplied via environment.`));
  let shuttingDown=false;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{
    if(shuttingDown)return;shuttingDown=true;
    app.stopTimers();
    const force=setTimeout(()=>process.exit(1),55000);force.unref();
    try{for(const room of app.store.rooms())await app.runtime.stop(room.id);}
    catch(error){console.error('Shutdown:',error.message);}
    app.server.close(()=>{app.mods.translation.close();app.store.close();clearTimeout(force);process.exit(0);});
  });
}
