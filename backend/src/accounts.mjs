import fs from 'node:fs';
import crypto from 'node:crypto';
import { atomic, demand, inside, Fault } from './core.mjs';
import { safeEqual } from './security.mjs';

const USERNAME=/^[\p{L}\p{N}][\p{L}\p{N}_.@-]{2,31}$/u;
const HASH=/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const cleanUsername=value=>String(value??'').trim().normalize('NFKC');
function validateUsername(value){const username=cleanUsername(value);demand(USERNAME.test(username),'用户名需为 3～32 位字母、数字或 . _ @ -');return username;}
function validatePassword(value){demand(typeof value==='string'&&value.length>=10&&value.length<=128,'密码需为 10～128 个字符');return value;}
let activeHashes=0;
async function derive(password,salt){
  demand(activeHashes<2,'登录繁忙，请稍后重试',429);activeHashes++;
  try{return await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024},(error,result)=>error?reject(error):resolve(result)));}
  finally{activeHashes--;}
}
async function passwordHash(password){
  const salt=crypto.randomBytes(16),N=16384,r=8,p=1;
  const hash=await derive(password,salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function passwordEqual(password,encoded){
  const match=HASH.exec(encoded||'');if(!match)return false;
  const [,N,r,p,saltHex,hashHex]=match;
  if(N!=='16384'||r!=='8'||p!=='1')return false;
  try{
    const actual=await derive(password,Buffer.from(saltHex,'hex'));
    return crypto.timingSafeEqual(actual,Buffer.from(hashHex,'hex'));
  }catch(error){if(error.status===429)throw error;return false;}
}

export class Accounts {
  constructor(store){
    this.store=store;this.config=store.config;
    store.db.exec('CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL COLLATE NOCASE UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT \'admin\',disabled INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,last_login TEXT)');
    const keyFile=inside(store.config.data,'setup-key');
    this.setupKeyFile=keyFile;
    if(!fs.existsSync(keyFile)&&this.count()===0){atomic(keyFile,crypto.randomBytes(32).toString('base64url')+'\n');fs.chmodSync(keyFile,0o600);}
  }
  count(){return this.store.db.prepare('SELECT COUNT(*) AS count FROM users WHERE disabled=0').get().count;}
  hasUsers(){return this.count()>0;}
  setupKey(){try{return fs.readFileSync(this.setupKeyFile,'utf8').trim();}catch{return '';}}
  publicStatus(){return {setupRequired:!this.hasUsers(),registrationAllowed:this.hasUsers()&&this.config.allowRegistration===true};}
  user(row){return row?{id:Number(row.id),username:row.username,role:row.role,disabled:Boolean(row.disabled),created:row.created,lastLogin:row.last_login||null}:null;}
  async create(username,password,role='operator',initial=false){
    username=validateUsername(username);password=validatePassword(password);demand(['admin','operator'].includes(role),'账号角色不合法');
    const encoded=await passwordHash(password);
    if(initial)demand(!this.hasUsers(),'管理员账号已经创建，请直接登录',409);
    demand(this.store.db.prepare('SELECT COUNT(*) AS count FROM users').get().count<100,'账号数量已达上限',409);
    try{const result=this.store.db.prepare('INSERT INTO users(username,password_hash,role,disabled,created) VALUES(?,?,?,?,?)').run(username,encoded,role,0,new Date().toISOString());return this.user(this.store.db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid));}
    catch(error){if(String(error.message).includes('UNIQUE'))throw new Fault(409,'用户名已存在');throw error;}
  }
  async setup(input,authorization=''){
    demand(!this.hasUsers(),'管理员账号已经创建，请直接登录',409);
    const setupKey=this.setupKey();
    const accepted=(setupKey&&safeEqual(setupKey,authorization))||safeEqual(this.store.adminToken,authorization);
    demand(accepted,'首次创建管理员需要 setup-key 或旧管理员密钥',401);
    const user=await this.create(input.username,input.password,'admin',true);fs.rmSync(this.setupKeyFile,{force:true});return user;
  }
  async changePassword(id,password,currentPassword){
    validatePassword(password);const row=this.store.db.prepare('SELECT id,password_hash FROM users WHERE id=? AND disabled=0').get(Number(id));demand(row,'账号不存在',404);
    demand(typeof currentPassword==='string'&&currentPassword.length<=128&&await passwordEqual(currentPassword,row.password_hash),'当前密码不正确',401);
    const encoded=await passwordHash(password);
    const result=this.store.db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=? AND disabled=0').run(encoded,Number(id),row.password_hash);demand(result.changes===1,'账号已变更，请重新登录',409);
    this.store.db.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(Number(id));return {changed:true,id:Number(id)};
  }
  async authenticate(username,password){
    username=validateUsername(username);validatePassword(password);
    const row=this.store.db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE AND disabled=0').get(username);
    const valid=await passwordEqual(password,row?.password_hash||'scrypt$16384$8$1$00000000000000000000000000000000$'+'0'.repeat(128));
    if(!row||!valid)return null;
    const current=this.store.db.prepare('SELECT password_hash,disabled FROM users WHERE id=?').get(row.id);
    if(!current||current.disabled||current.password_hash!==row.password_hash)return null;
    this.store.db.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(),row.id);return this.user(row);
  }
  list(){return this.store.db.prepare('SELECT id,username,role,disabled,created,last_login FROM users ORDER BY id').all().map(row=>this.user(row));}
  remove(id){const row=this.store.db.prepare('SELECT * FROM users WHERE id=?').get(Number(id));demand(row,'账号不存在',404);demand(row.disabled||row.role!=='admin'||this.store.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled=0").get().count>1,'至少保留一个管理员账号',409);this.store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(Number(id));this.store.db.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(Number(id));return {removed:true,id:Number(id)};}
}

export { cleanUsername, validatePassword, validateUsername, passwordHash, passwordEqual };
