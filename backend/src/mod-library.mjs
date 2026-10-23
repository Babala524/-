import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { demand, inside, modID, atomic, jsonRead, exec, walk, Fault } from './core.mjs';
import { parseLua } from './lua.mjs';
import {ensureNative} from './native-dependencies.mjs';

const HASH=/^[a-f0-9]{64}$/;
export const packageLimit=512*1048576;
const unpackLimit=2048*1048576;
const digest=file=>{const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1048576);try{let size;while((size=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,size));return hash.digest('hex');}finally{fs.closeSync(fd);}};
const brief=(value,max)=>String(value??'').trim().slice(0,max);
function record(input) {
  demand(input&&typeof input==='object','模组记录不合法');
  const id=modID(input.id),hash=String(input.hash||'');demand(HASH.test(hash),'模组校验值不合法');
  const size=Number(input.size);demand(Number.isSafeInteger(size)&&size>0&&size<=packageLimit,'模组包体积不合法');
  return {id,hash,size,name:brief(input.name,180)||'Workshop '+id,version:brief(input.version,80)||'上传版本',author:brief(input.author,180),description:brief(input.description,2000)};
}

// This parses literal metadata only. Uploaded Lua is never run by the panel.
function metadata(folder,id) {
  const file=inside(folder,'modinfo.lua');demand(fs.statSync(file).size<=1048576,'modinfo.lua 过大');
  const source=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
  const values={};
  try {
    for(const node of parseLua(source,1048576).body){
      if(node.type!=='AssignmentStatement')continue;
      node.variables.forEach((variable,index)=>{
        const value=node.init[index];
        if(variable.type==='Identifier'&&['name','version','author','description'].includes(variable.name)&&value?.type==='StringLiteral'){
          const raw=value.raw;
          values[variable.name]=raw.startsWith('[')?raw.replace(/^\[=*\[\r?\n?/,'').replace(/\]=*\]$/,''):raw.slice(1,-1).replace(/\\([nrt"'\\])/g,(_,c)=>({n:'\n',r:'\r',t:'\t'}[c]||c));
        }
      });
    }
  } catch { /* Valid game mods may use a newer Lua grammar; the admin can name them. */ }
  return {...values,id,name:values.name||'Workshop '+id};
}

export class ModLibrary {
  constructor(store) { this.store=store;this.config=store.config;this.fetch=fetch;this.receiving=0;this.rates=new Map(); }
  file(relative){return inside(this.config.data,'mod-library/'+relative);}
  package(hash){demand(HASH.test(String(hash)),'模组校验值不合法');return this.file('packages/'+hash+'.zip');}
  entry(id){return jsonRead(this.file('local/'+modID(id)+'.json'));}
  icon(hash){demand(HASH.test(String(hash)),'模组校验值不合法');return this.file('icons/'+hash+'.png');}
  checkSpace(hash,size){if(fs.existsSync(this.package(hash)))return;const dir=this.file('packages'),used=fs.existsSync(dir)?fs.readdirSync(dir).filter(name=>/^[a-f0-9]{64}\.zip$/.test(name)).reduce((total,name)=>total+fs.statSync(inside(dir,name)).size,0):0;demand(used+size<=(this.config.modLibraryLimit||4096*1048576),'模组库已达到容量限制，请清理不需要的记录或扩容',507);}
  async renderIcon(folder,hash){try{await ensureNative(this.config,'map');await exec(this.config.python,[path.join(this.config.root,'backend/scripts/mod_icon.py'),folder,this.icon(hash)],{timeout:15000,maxBuffer:65536});}catch{/* Icons are optional. */}}
  storePackage(source,hash,size){this.checkSpace(hash,size);const target=this.package(hash);if(fs.existsSync(target)&&digest(target)===hash)return;fs.mkdirSync(path.dirname(target),{recursive:true});const temporary=target+'.'+crypto.randomUUID()+'.tmp';try{fs.copyFileSync(source,temporary,fs.constants.COPYFILE_EXCL);fs.chmodSync(temporary,0o600);fs.renameSync(temporary,target);}finally{fs.rmSync(temporary,{force:true});}}
  rows(kind='local') {
    demand(['local','published','pending'].includes(kind),'未知模组目录');
    const dir=this.file(kind);if(!fs.existsSync(dir))return [];
    return fs.readdirSync(dir).filter(name=>/^(?:\d{6,20}|[a-f0-9]{64})\.json$/.test(name)).map(name=>jsonRead(inside(dir,name))).filter(Boolean);
  }
  async unpack(archive,destination) {
    await ensureNative(this.config,'python');
    try{await exec(this.config.python,[path.join(this.config.root,'backend/scripts/archive.py'),'mod-extract',archive,destination,String(unpackLimit)],{timeout:120000,maxBuffer:1048576});}
    catch(error){throw new Fault(422,'模组包校验失败：'+brief(error.stderr||error.message,300));}
    walk(destination);demand(fs.existsSync(inside(destination,'modmain.lua')),'模组包缺少 modmain.lua，无法作为服务端模组安装',422);
  }
  async serial(operation) {
    const tail=this.tail||Promise.resolve(),next=tail.catch(()=>{}).then(operation);this.tail=next;
    return next;
  }
  async remember(archive,id,{name,origin='local-upload',expectedHash}={}) {
    id=modID(id);
    return this.serial(async()=>{
      const dir=this.file('tmp/'+crypto.randomUUID()),canonical=dir+'.zip';fs.mkdirSync(path.dirname(dir),{recursive:true});
      try {
        await this.unpack(archive,dir);
        const info=metadata(dir,id);if(name)info.name=brief(name,180);
        let saved=archive;
        if(!expectedHash){await exec(this.config.python,[path.join(this.config.root,'backend/scripts/archive.py'),'mod-pack',dir,canonical,String(unpackLimit)],{timeout:120000,maxBuffer:1048576});saved=canonical;}
        const hash=digest(saved);if(expectedHash)demand(hash===expectedHash,'共享模组校验失败，文件未安装',422);
        const row={...record({...info,hash,size:fs.statSync(saved).size}),origin,importedAt:new Date().toISOString()};
        this.storePackage(saved,hash,row.size);
        await this.renderIcon(dir,hash);
        atomic(this.file('local/'+id+'.json'),JSON.stringify(row));return row;
      }finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(canonical,{force:true});}
    });
  }
  async capture(id,folder) {
    await ensureNative(this.config,'python');
    id=modID(id);const archive=this.file('tmp/'+crypto.randomUUID()+'.zip');fs.mkdirSync(path.dirname(archive),{recursive:true});
    try{walk(folder);await exec(this.config.python,[path.join(this.config.root,'backend/scripts/archive.py'),'mod-pack',folder,archive,String(unpackLimit)],{timeout:120000,maxBuffer:1048576});return await this.remember(archive,id);}
    finally{fs.rmSync(archive,{force:true});}
  }
  async extract(id,slot) {
    const entry=this.entry(id);demand(entry,'本地收录中没有这个模组',404);
    const file=this.package(entry.hash);demand(fs.existsSync(file)&&digest(file)===entry.hash,'本地模组包缺失或校验失败',422);
    const target=this.file('workers/'+slot);fs.rmSync(target,{recursive:true,force:true});
    await this.unpack(file,target);return target;
  }
  searchLocal({searchText='',page=1,pageSize=36}={}){
    const query=String(searchText).toLocaleLowerCase();const matches=this.rows().filter(row=>(row.name+' '+row.id).toLocaleLowerCase().includes(query));
    return {rows:matches.slice((page-1)*pageSize,page*pageSize).map(row=>({...row,source:'local-library',preview_url:fs.existsSync(this.icon(row.hash))?'/api/mod-library/icons/'+row.hash+'.png':''})),total:matches.length,source:'local-library'};
  }
  remoteURL(suffix='') {
    let url;try{url=new URL(this.config.modRegistry);}catch{throw new Fault(409,'尚未配置共享模组库地址');}
    demand(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash,'共享模组库地址不合法');
    url.pathname=url.pathname.replace(/\/$/,'')+'/registry/v1/';return new URL(suffix,url);
  }
  async remoteJSON(suffix,options={}) {
    const response=await this.fetch(this.remoteURL(suffix),{...options,redirect:'error',signal:AbortSignal.timeout(options.method==='POST'?180000:15000)});
    const text=await limitedText(response,1048576);let payload;try{payload=JSON.parse(text);}catch{throw new Fault(502,'共享库返回格式不合法');}
    demand(response.ok,payload.error||'共享库暂不可用',response.status>=500?502:response.status);return payload.data;
  }
  async searchRemote(input) {
    if(this.config.modRegistryHost){const result=this.publicList({q:input.searchText,page:input.page,pageSize:input.pageSize});return {...result,rows:result.rows.map(row=>({...record(row),source:'community-library',preview_url:row.preview_url||''})),source:'community-library'};}
    const query=new URLSearchParams({q:input.searchText||'',page:String(input.page||1),pageSize:String(input.pageSize||36)});
    const data=await this.remoteJSON('mods?'+query);
    demand(Array.isArray(data?.rows)&&data.rows.length<=50&&Number.isSafeInteger(data.total)&&data.total>=0,'共享库搜索结果不合法',502);
    return {rows:data.rows.map(row=>({...record(row),source:'community-library',preview_url:row.preview_url?'/api/mod-library/community-icons/'+row.hash+'.png':''})),total:data.total,source:'community-library'};
  }
  async remoteIcon(hash){demand(HASH.test(String(hash)),'模组校验值不合法');const response=await this.fetch(this.remoteURL('icons/'+hash+'.png'),{redirect:'error',signal:AbortSignal.timeout(10000)});demand(response.ok,'共享模组图标暂不可用',404);const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;demand(size<=524288,'共享模组图标过大',502);chunks.push(chunk);}const image=Buffer.concat(chunks);demand(image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'共享模组图标格式不合法',502);return image;}
  async pull(id,hash,report=()=>{}) {
    id=modID(id);demand(HASH.test(String(hash)),'请选择共享库里的具体模组版本');
    const data=await this.remoteJSON('mods/'+id);const row=record(data);demand(row.id===id&&row.hash===hash,'共享库版本已变化，请刷新后重新下载',409);
    const temp=this.file('tmp/'+crypto.randomUUID()+'.zip');fs.mkdirSync(path.dirname(temp),{recursive:true});
    try {
      const response=await this.fetch(this.remoteURL('packages/'+hash+'.zip'),{redirect:'error',signal:AbortSignal.timeout(180000)});
      demand(response.ok&&response.body,'共享模组下载失败',502);let received=0;
      await pipeline(Readable.from((async function*(){for await(const chunk of response.body){received+=chunk.length;demand(received<=row.size,'共享模组包超过声明大小',413);report(Math.min(99,received/row.size*100),'正在下载共享模组',{stage:'downloading',downloadedBytes:received,totalBytes:row.size});yield chunk;}})()),fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
      demand(received===row.size&&digest(temp)===hash,'共享模组校验失败，现有文件保留',422);
      return await this.remember(temp,id,{name:row.name,origin:'community-library',expectedHash:hash});
    }finally{fs.rmSync(temp,{force:true});}
  }
  // Public uploads are quarantined. Only the authenticated host administrator can publish.
  reserve(ip) {
    demand(this.config.modRegistryHost,'本面板未开启共享库托管',404);
    const now=Date.now();for(const [key,rate] of this.rates)if(now-rate.at>3600000)this.rates.delete(key);
    const previous=this.rates.get(ip),rate=previous||{at:now,count:0};demand(rate.count<3,'每小时最多提交 3 个模组，请稍后再试',429);
    const pending=this.rows('pending');
    demand(this.receiving<1&&pending.length+this.receiving<20&&pending.reduce((n,row)=>n+row.size,0)+(this.receiving+1)*packageLimit<=2048*1048576,'共享库待审核队列已满，请联系管理员',429);
    demand(this.rates.size<10000||previous,'提交来源过多，请稍后重试',429);
    rate.count++;this.rates.set(ip,rate);this.receiving++;return ()=>{this.receiving--;};
  }
  async accept(archive,input) {
    demand(input.consent===true,'请先确认作者允许公开分发');
    const row=record(input);demand(fs.statSync(archive).size===row.size&&digest(archive)===row.hash,'提交包的大小或校验值不符',422);
    return this.serial(async()=>{
      const existing=jsonRead(this.file('pending/'+row.hash+'.json'));
      if(existing)return {submitted:true,hash:row.hash,state:'pending'};
      if(this.rows('published').some(item=>item.id===row.id&&item.hash===row.hash))return {submitted:true,hash:row.hash,state:'published'};
      const temp=this.file('tmp/'+crypto.randomUUID());
      try{this.checkSpace(row.hash,row.size);await this.unpack(archive,temp);metadata(temp,row.id);this.storePackage(archive,row.hash,row.size);
        await this.renderIcon(temp,row.hash);
        atomic(this.file('pending/'+row.hash+'.json'),JSON.stringify({...row,submittedAt:new Date().toISOString(),consent:true}));
        return {submitted:true,hash:row.hash,state:'pending'};
      }finally{fs.rmSync(temp,{recursive:true,force:true});}
    });
  }
  async submit(id,consent) {
    demand(consent===true,'发布前请确认作者允许公开分发');
    const row=this.entry(id);demand(row,'请先收录或上传完整模组包',404);
    const archive=this.package(row.hash);demand(fs.existsSync(archive)&&digest(archive)===row.hash,'本地模组包校验失败',422);
    if(this.config.modRegistryHost)return this.accept(archive,{...row,consent:true});
    const metadata=Buffer.from(JSON.stringify({...record(row),consent:true})).toString('base64url');
    return this.remoteJSON('submissions',{method:'POST',headers:{'Content-Type':'application/zip','Content-Length':String(row.size),'X-Feather-Mod':metadata},body:fs.createReadStream(archive),duplex:'half'});
  }
  review(hash,publish) {
    demand(this.config.modRegistryHost,'本面板未开启共享库托管',404);demand(HASH.test(String(hash)),'提交校验值不合法');
    const file=this.file('pending/'+hash+'.json'),entry=jsonRead(file);demand(entry,'提交已处理或不存在',404);
    if(publish){demand(fs.existsSync(this.package(hash))&&digest(this.package(hash))===hash,'共享模组包已损坏',422);atomic(this.file('published/'+entry.id+'.json'),JSON.stringify({...record(entry),publishedAt:new Date().toISOString()}));}
    fs.rmSync(file,{force:true});if(!publish)this.gc(hash);
    return {reviewed:true,published:publish,id:entry.id};
  }
  gc(hash) {if(!['local','pending','published'].some(kind=>this.rows(kind).some(row=>row.hash===hash))){fs.rmSync(this.package(hash),{force:true});fs.rmSync(this.icon(hash),{force:true});}}
  unpublish(id) {demand(this.config.modRegistryHost,'本面板未开启共享库托管',404);const file=this.file('published/'+modID(id)+'.json'),row=jsonRead(file);demand(row,'模组未发布',404);fs.rmSync(file,{force:true});this.gc(row.hash);return {unpublished:true};}
  removeLocal(id){id=modID(id);const entry=this.entry(id);demand(entry,'收录记录不存在',404);fs.rmSync(this.file('local/'+id+'.json'),{force:true});this.gc(entry.hash);return {removed:true,id};}
  publicList(input) {
    const page=Number(input.page||1),pageSize=Number(input.pageSize||36),q=brief(input.q,160).toLocaleLowerCase();
    demand(Number.isInteger(page)&&page>=1&&page<=100&&Number.isInteger(pageSize)&&pageSize>=1&&pageSize<=50,'分页参数不合法');
    const rows=this.rows('published').filter(row=>(row.name+' '+row.id).toLocaleLowerCase().includes(q));
    return {rows:rows.slice((page-1)*pageSize,page*pageSize).map(row=>({...row,preview_url:fs.existsSync(this.icon(row.hash))?'/registry/v1/icons/'+row.hash+'.png':''})),total:rows.length};
  }
  publicEntry(id){const row=jsonRead(this.file('published/'+modID(id)+'.json'));demand(row,'共享模组不存在或已下架',404);return row;}
  publicPackage(hash){demand(this.rows('published').some(row=>row.hash===hash),'共享模组不存在或未审核',404);const file=this.package(hash);demand(fs.existsSync(file),'共享模组包暂不可用',404);return file;}
  status(){return {host:this.config.modRegistryHost,registry:this.config.modRegistry||'',local:this.rows(),pending:this.config.modRegistryHost?this.rows('pending'):[],published:this.config.modRegistryHost?this.rows('published'):[]};}
}
async function limitedText(response,limit){let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;demand(size<=limit,'共享库响应过大',502);chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
