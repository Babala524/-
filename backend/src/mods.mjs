import fs from 'node:fs';
import path from 'node:path';
import { demand, Fault, inside, modID, atomic, humanSize, walk, jsonRead, sha } from './core.mjs';
import { modFields, lua } from './lua.mjs';
import { downloadWorkshop } from './workshop-download.mjs';
import { installedRevision } from './workshop-state.mjs';
import { ModAutoTranslate } from './mod-auto-translate.mjs';
import { ModLibrary } from './mod-library.mjs';
import {ensureSteam} from './native-dependencies.mjs';

export class Mods {
  constructor(store,runtime) { this.store=store;this.runtime=runtime;this.config=store.config;this.jobs=new Map();this.history=[];this.slots=new Set();this.waiters=[];this.searchInflight=new Map();this.downloadRunner=downloadWorkshop;this.fetch=fetch;this.translation=new ModAutoTranslate(store); }
  async steamJSON(url,options={}) {
    for(let attempt=0;attempt<2;attempt++){
      try{const response=await this.fetch(url,{...options,signal:AbortSignal.timeout(3500)});if(response.ok)return await response.json();if(response.status===429||response.status>=500)continue;throw new Fault(502,'Steam 未接受查询，请稍后重试');}
      catch(error){if(error.status)throw error;if(attempt===1)throw new Fault(504,'连接 Steam 超时，请稍后重试或查询已安装模组');}
    }
    throw new Fault(502,'Steam 暂时不可用，请稍后重试');
  }
  get library() { return this._library ||= new ModLibrary(this.store); }
  metadata(id) { return inside(this.config.data,`workshop-meta/${modID(id)}.json`); }
  receipt(id) { return inside(this.config.data,`workshop-installed/${modID(id)}.json`); }
  pending(id) { return inside(this.config.data,`workshop-pending/${modID(id)}`); }
  revision(id,slot) {
    return installedRevision(inside(this.config.data,`workshop-workers/worker-${slot}/download/steamapps/workshop/appworkshop_322330.acf`),id);
  }
  localRevision(id,folder) {
    const receipt=jsonRead(this.receipt(id));if(receipt)return receipt;
    let revision=installedRevision(inside(this.config.game,'steamapps/workshop/appworkshop_322330.acf'),id);
    if(!revision)for(let slot=0;slot<3;slot++){
      const candidate=this.revision(id,slot),base=inside(this.config.data,`workshop-workers/worker-${slot}/download`);
      const paths=[`steamapps/workshop/content/322330/${id}/modinfo.lua`,'legacy-extracted/modinfo.lua'];
      if(candidate&&paths.some(file=>fs.existsSync(inside(base,file))&&sha(fs.readFileSync(inside(base,file),'utf8'))===sha(fs.readFileSync(inside(folder,'modinfo.lua'),'utf8')))){revision=candidate;break;}
    }
    if(revision)atomic(this.receipt(id),JSON.stringify(revision));
    return revision;
  }
  find(id) {
    id=modID(id);
    for(const relative of [`mods/workshop-${id}`,`steamapps/workshop/content/322330/${id}`]) {
      const target=inside(this.config.game,relative);
      if(fs.existsSync(inside(target,'modinfo.lua'))) return target;
    }
    return null;
  }
  installedIDs() {
    const ids=new Set();
    const mods=inside(this.config.game,'mods'), workshop=inside(this.config.game,'steamapps/workshop/content/322330');
    if(fs.existsSync(mods)) fs.readdirSync(mods).forEach(name=>{const id=name.match(/^workshop-(\d{6,20})$/)?.[1];if(id)ids.add(id);});
    if(fs.existsSync(workshop)) fs.readdirSync(workshop).forEach(name=>{if(/^\d{6,20}$/.test(name))ids.add(name);});
    return [...ids].filter(id=>this.find(id));
  }
  async installed(roomID,force=false) {
    this.store.getRoom(roomID); const ids=this.installedIDs();
    const missing=ids.filter(id=>{const info=jsonRead(this.metadata(id),{});return force||!info.preview_url||!info.fetchedAt||Date.now()-Date.parse(info.fetchedAt)>300000;});
    let warning='';for(let i=0;i<missing.length;i+=100)try{const result=await this.details(missing.slice(i,i+100));warning=result.warning||warning;}catch{warning='工坊版本检查失败，保留上次结果';}
    return {warning,rows:[...ids].filter(id=>this.find(id)).map(id=>{
      const folder=this.find(id),info=jsonRead(this.metadata(id),{}),size=walk(folder).reduce((sum,file)=>sum+fs.statSync(file).size,0);
      const local=this.localRevision(id,folder),latest=Number(info.version)||0,pending=fs.existsSync(inside(this.pending(id),'files/modinfo.lua'));
      const updateState=pending?'pending':!latest||!local?.timeUpdated?'unknown':latest>local.timeUpdated?'outdated':'current';
      const archived=local?.source==='local-library'?local:null,fallback=this.library.entry(id);
      return {id,name:archived?.name||info.name||fallback?.name||`Workshop ${id}`,localSize:humanSize(size),version:archived?.version||info.version||fallback?.version||'本地安装',preview_url:String(info.preview_url||(fallback&&fs.existsSync(this.library.icon(fallback.hash))?'/api/mod-library/icons/'+fallback.hash+'.png':'')),description:String(archived?.description||info.description||fallback?.description||''),subscriptions:Number(info.subscriptions||0),source:'installed',librarySource:archived?.origin||null,updateState:archived?(pending?'pending':'local'):updateState,installedUpdatedAt:local?.timeUpdated||null,latestUpdatedAt:latest||null,versionCheckedAt:info.fetchedAt||null};
    })};
  }
  async details(ids) {
    demand(Array.isArray(ids)&&ids.length<=100,'模组查询数量过多');
    ids=ids.map(modID); if(!ids.length)return {rows:[]};
    const body=new URLSearchParams({itemcount:String(ids.length)});ids.forEach((id,index)=>body.set(`publishedfileids[${index}]`,id));
    let rows=[],error=null;
    try {
      const data=await this.steamJSON('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',{method:'POST',body});
      rows=(data.response?.publishedfiledetails||[]).filter(row=>row.result===1&&Number(row.consumer_app_id)===322330&&ids.includes(String(row.publishedfileid))).map(row=>({id:String(row.publishedfileid),name:String(row.title||row.publishedfileid),version:String(row.time_updated||''),fileSize:Number(row.file_size)||null,file_url:String(row.file_url||''),preview_url:String(row.preview_url||''),description:String(row.file_description||''),subscriptions:Number(row.subscriptions||0),vote_data:row.vote_data||null,fetchedAt:new Date().toISOString()}));
    } catch(cause){error=cause;}
    if(error){rows=ids.map(id=>jsonRead(this.metadata(id))).filter(Boolean).map(row=>({...row,cached:true}));if(!rows.length)throw error;}
    else for(const row of rows){const previous=jsonRead(this.metadata(row.id),{});row.preview_url=row.preview_url||previous.preview_url||'';atomic(this.metadata(row.id),JSON.stringify({...previous,...row}));}
    return {rows,source:error?'cache':'steam',warning:error?'Steam 暂不可用，显示上次查询缓存':null};
  }
  async search({page=1,pageSize=20,searchType='text',searchText='',source='workshop'}) {
    demand(Number.isInteger(page)&&page>=1&&page<=100,'搜索页数不合法');
    demand(Number.isInteger(pageSize)&&pageSize>=1&&pageSize<=50,'搜索条数不合法');
    demand(['id','text'].includes(searchType),'未知搜索类型');
    searchText=String(searchText).trim();demand(searchText.length<=160,'模组名称过长');
    demand(['workshop','local','community'].includes(source),'未知模组来源');
    if(source==='local')return this.library.searchLocal({page,pageSize,searchText});
    if(source==='community')return this.library.searchRemote({page,pageSize,searchText});
    if(searchType==='id') demand(searchText,'请输入模组 ID');
    if(searchType==='id'){const result=await this.details([searchText]);return {...result,total:result.rows.length};}
    if(!this.config.steamKey){
      // ID lookup remains available without a key. Search cached names honestly when Steam search is not configured.
      const folder=inside(this.config.data,'workshop-meta'),all=fs.existsSync(folder)?fs.readdirSync(folder).filter(file=>/^\d{6,20}\.json$/.test(file)).map(file=>jsonRead(inside(folder,file))).filter(Boolean):[];
      const matches=all.filter(row=>row.name.toLowerCase().includes(searchText.toLowerCase()));
      if(matches.length)return {rows:matches.slice((page-1)*pageSize,page*pageSize),total:matches.length,source:'cache',warning:'仅搜索本机已查询的工坊缓存；全工坊搜索服务暂不可用'};
      throw new Fault(409,'当前未配置 Steam 工坊搜索服务；可以通过 ID 查询和下载模组');
    }
    const cachedFile=inside(this.config.data,'workshop-search/'+sha(JSON.stringify([searchText,page,pageSize]))+'.json');
    const cached=jsonRead(cachedFile);
    if(cached&&Date.now()-cached.fetchedAt<600000)return {...cached.data,source:'steam-cache'};
    const cacheResult=cached?{...cached.data,source:'steam-cache',warning:'工坊响应较慢，先显示上次结果，正在后台刷新；刷新失败仍保留上次查询结果'}:null;
    const cacheKey=cachedFile;
    if(cacheResult){
      if(!this.searchInflight.has(cacheKey)){
        const refresh=this.searchRemote(searchText,page,pageSize,cachedFile).catch(()=>null).finally(()=>this.searchInflight.delete(cacheKey));
        this.searchInflight.set(cacheKey,refresh);
      }
      return cacheResult;
    }
    if(this.searchInflight.has(cacheKey))return this.searchInflight.get(cacheKey);
    const request=this.searchRemote(searchText,page,pageSize,cachedFile).finally(()=>this.searchInflight.delete(cacheKey));
    this.searchInflight.set(cacheKey,request);
    return request;
  }
  async searchRemote(searchText,page,pageSize,cachedFile) {
    const query=new URLSearchParams({key:this.config.steamKey,appid:'322330',return_details:'true',return_vote_data:'true',return_children:'true','requiredtags[0]':'server_only_mod','requiredtags[1]':'all_clients_require_mod',match_all_tags:'false',language:'6',page:String(page),numperpage:String(pageSize),return_metadata:'true'});
    if(searchText) query.set('search_text',searchText);
    try{
      const payload=await this.steamJSON('https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?'+query);
      const response=payload.response;
      demand(response&&(response.result===undefined||response.result===1)&&Number.isSafeInteger(response.total)&&response.total>=0&&(Array.isArray(response.publishedfiledetails)||response.total===0),'创意工坊没有返回有效搜索结果',502);
      const data={rows:(response.publishedfiledetails||[]).filter(row=>/^\d{6,20}$/.test(String(row.publishedfileid))&&(row.consumer_app_id===undefined||Number(row.consumer_app_id)===322330)).map(row=>({id:String(row.publishedfileid),name:String(row.title||row.publishedfileid),description:String(row.file_description||''),preview_url:String(row.preview_url||''),subscriptions:Number(row.subscriptions||0),vote_data:row.vote_data||null,tags:Array.isArray(row.tags)?row.tags:[],version:String(row.time_updated||''),source:'workshop'})),total:response.total,source:'steam'};
      atomic(cachedFile,JSON.stringify({fetchedAt:Date.now(),data}));
      for(const row of data.rows)atomic(this.metadata(row.id),JSON.stringify({...jsonRead(this.metadata(row.id),{}),...row,fetchedAt:new Date().toISOString()}));
      return data;
    }catch(error){
      const cached=jsonRead(cachedFile);
      if(cached)return {...cached.data,source:'steam-cache',warning:'Steam 暂不可用，显示上次工坊查询结果'};
      throw error;
    }
  }
  configFields(roomID,id,options={}) {
    const room=this.store.getRoom(roomID),folder=this.find(id);demand(folder,'该模组尚未安装',404);
    let fields;
    try{fields=modFields(fs.readFileSync(inside(folder,'modinfo.lua'),'utf8'),'workshop-'+id);}
    catch(error){throw new Fault(422,'模组配置解析失败：'+error.message);}
    return {...this.translation.fields(fields,options),values:room.mods.find(mod=>mod.id===String(id))?.config||{}};
  }
  downloads() {
    return {rows:[...this.history,...this.jobs.values()].map(job=>({...this.store.getTask(job.taskID),modID:job.id,name:job.name})),limit:3};
  }
  enqueue(roomID,id,options={}) {
    this.store.getRoom(roomID);id=modID(id);
    const existing=this.jobs.get(id);if(existing)return {taskID:existing.taskID,deduplicated:true};
    this.history=this.history.filter(job=>job.id!==id);
    demand(!this.store.sharedBusy,'游戏文件正在更新，请稍后下载',409);
    const job={id,name:jsonRead(this.metadata(id),{}).name||'Workshop '+id};
    const task=this.store.task('下载模组',roomID,async report=>{
      let slot;
      try{
        report(null,'正在排队，最多同时下载 3 个模组',{modID:id,stage:'queued'});
        slot=await this.acquire();
        const updating=Boolean(this.find(id));
        const result=await this.download(roomID,id,(progress,message,detail={})=>report(progress,message,{...detail,modID:id}),slot,options);
        if(updating)this.onUpdated?.({taskID:job.taskID,id,name:job.name,result,automatic:options.automatic});
        return result;
      }finally{
        if(slot!==undefined)this.release(slot);
        this.jobs.delete(id);this.history.push(job);this.history=this.history.slice(-12);
      }
    });
    job.taskID=task.taskID;this.jobs.set(id,job);return task;
  }
  acquire() {
    for(let slot=0;slot<3;slot++)if(!this.slots.has(slot)){this.slots.add(slot);return Promise.resolve(slot);}
    return new Promise(resolve=>this.waiters.push(resolve));
  }
  release(slot) { const next=this.waiters.shift();if(next)next(slot);else this.slots.delete(slot); }
  async ensureInstalled(roomID, ids, report=()=>{}) {
    const wanted=[...new Set((ids||[]).map(value=>modID(value)))];
    const missing=wanted.filter(id=>!this.find(id));
    if(!missing.length)return {installed:[],missing:[]};
    if(this.downloadRunner===downloadWorkshop&&missing.some(id=>!this.library.entry(id))){
      demand(process.platform==='linux','恢复存档需要 Linux + SteamCMD 才能下载存档模组',503);
      await ensureSteam(this.config,report);
      demand(fs.existsSync(inside(this.config.steam,'steamcmd.sh')),'未安装 SteamCMD，无法下载存档模组',409);
    }
    const installed=[];
    for(const [index,id] of missing.entries()){
      let slot;
      try{
        slot=await this.acquire();
        report(null,`正在下载存档模组 ${index+1}/${missing.length}`,{modID:id,stage:'downloading'});
        await this.download(roomID,id,(progress,message,detail={})=>report(progress,message,{...detail,modID:id}),slot);
        installed.push(id);
      } finally { if(slot!==undefined)this.release(slot); }
    }
    return {installed,missing:wanted.filter(id=>!this.find(id))};
  }
  async download(roomID,id,report=()=>{},slot=0,options={}) {
    this.store.getRoom(roomID);id=modID(id);
    if(options.source==='community-library')await this.library.pull(id,options.hash,report);
    const archived=!options.workshop&&options.source!=='workshop'&&this.library.entry(id);
    demand(!(options.workshop&&jsonRead(this.receipt(id),{})?.source==='local-library'),'这个模组来自上传或共享库，请重新上传或从共享库选择版本更新',409);
    if(this.downloadRunner===downloadWorkshop&&!archived){
      demand(process.platform==='linux','下载模组需要 Linux + SteamCMD 部署环境',503);
      await ensureSteam(this.config,report);
      demand(fs.existsSync(inside(this.config.steam,'steamcmd.sh')),'未安装 SteamCMD',409);
      try{await this.details([id]);}catch{}
    }
    const source=archived?await this.library.extract(id,slot):await this.downloadRunner(this.config,id,slot,report);walk(source);
    let revision=archived?{...archived,source:'local-library'}:this.revision(id,slot)||{};
    if(source.includes('workshop-http'))revision={timeUpdated:Number(jsonRead(this.metadata(id),{}).version)||null};
    let deferred=false;
    report(100,'文件已下载，正在安装到模组目录',{stage:'installing'});
    const previousPublish=this.publishTail||Promise.resolve();
    const publish=previousPublish.catch(()=>{}).then(async()=>{
      const until=Date.now()+60000;
      const ownRoomLock=this.store.locks.size===1&&this.store.locks.has(String(roomID));
      while(this.store.sharedBusy||(this.store.locks.size&&!ownRoomLock)){
        demand(Date.now()<until,'游戏操作尚未结束，请稍后重试安装模组',409);
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      this.store.sharedBusy=true;
      const destination=inside(this.config.game,'mods/workshop-'+id),staging=destination+'.new',previous=destination+'.old';
      try{
        demand(fs.existsSync(inside(source,'modinfo.lua')),'下载文件缺少 modinfo.lua',502);
        const live=this.find(id)&&(await Promise.all(this.store.rooms().map(room=>this.runtime.status(room.id)))).some(worlds=>worlds.some(world=>world.running));
        if(live||options.stageOnly){
          const pending=this.pending(id),next=pending+'.new';fs.rmSync(next,{recursive:true,force:true});fs.mkdirSync(next,{recursive:true});
          fs.cpSync(source,inside(next,'files'),{recursive:true,dereference:false});atomic(inside(next,'revision.json'),JSON.stringify(revision));
          fs.rmSync(pending,{recursive:true,force:true});fs.renameSync(next,pending);deferred=true;return;
        }
        fs.rmSync(staging,{recursive:true,force:true});fs.cpSync(source,staging,{recursive:true,dereference:false});
        fs.rmSync(previous,{recursive:true,force:true});
        if(fs.existsSync(destination))fs.renameSync(destination,previous);
        try{fs.renameSync(staging,destination);}catch(error){if(fs.existsSync(previous))fs.renameSync(previous,destination);throw error;}
        atomic(this.receipt(id),JSON.stringify(revision));fs.rmSync(this.pending(id),{recursive:true,force:true});
        fs.rmSync(previous,{recursive:true,force:true});
      }finally{this.store.sharedBusy=false;fs.rmSync(staging,{recursive:true,force:true});}
    });
    this.publishTail=publish;await publish;
    report(100,deferred?'更新已暂存，正在读取工坊信息':'安装完成，正在读取工坊信息',{stage:'metadata'});
    try{await this.details([id]);}catch{}
    this.store.event(roomID,'模组 '+id+(deferred?' 更新已暂存，重启后应用':' 已下载'));return {downloaded:true,deferred,id,progress:100,message:deferred?'更新已下载，待全部房间停止后启动时应用':'下载完成',stage:deferred?'pending-restart':'completed'};
  }
  async applyPending() {
    if(this.store.sharedBusy||this.store.locks.size>1)return;
    if((await Promise.all(this.store.rooms().map(room=>this.runtime.status(room.id)))).some(worlds=>worlds.some(world=>world.running)))return;
    if(this.store.sharedBusy||this.store.locks.size>1)return;
    const base=inside(this.config.data,'workshop-pending');if(!fs.existsSync(base))return;
    this.store.sharedBusy=true;
    try{for(const id of fs.readdirSync(base).filter(id=>/^\d{6,20}$/.test(id))){
      const pending=this.pending(id),source=inside(pending,'files');if(!fs.existsSync(inside(source,'modinfo.lua')))continue;
      const destination=inside(this.config.game,'mods/workshop-'+id),previous=destination+'.old';fs.rmSync(previous,{recursive:true,force:true});
      if(fs.existsSync(destination))fs.renameSync(destination,previous);
      try{fs.renameSync(source,destination);}catch(error){if(fs.existsSync(previous))fs.renameSync(previous,destination);throw error;}
      atomic(this.receipt(id),JSON.stringify(jsonRead(inside(pending,'revision.json'),{})));fs.rmSync(previous,{recursive:true,force:true});fs.rmSync(pending,{recursive:true,force:true});
    }}finally{this.store.sharedBusy=false;}
  }
  async remove(roomID,id) {
    this.store.getRoom(roomID);id=modID(id);demand(!this.jobs.size&&!this.store.sharedBusy&&this.store.locks.size<=1,'有游戏或模组任务正在执行',409);
    this.store.sharedBusy=true;
    try{
      for(const room of this.store.rooms())demand(!(await this.runtime.status(room.id)).some(world=>world.running),'删除共享模组前请关闭所有游戏房间',409);
      // Removing an installed mod also removes its room references while every world is stopped.
      // This keeps a later start from pointing at files that no longer exist.
      for(const room of this.store.rooms()){
        if(!room.mods.some(mod=>mod.id===id))continue;
        const data={...room,mods:room.mods.filter(mod=>mod.id!==id)};
        const content='return '+lua(Object.fromEntries(data.mods.filter(mod=>mod.enabled).map(mod=>['workshop-'+mod.id,{enabled:true,configuration_options:mod.config}])))+'\n';
        const files=data.worlds.map(world=>inside(this.store.cluster(room.id),world.directory+'/modoverrides.lua'));
        for(const file of files)atomic(file,content);
        this.store.putRoom(room.id,data);this.store.event(room.id,'模组 '+id+' 已从房间配置移除');
      }
      for(const relative of ['mods/workshop-'+id,'steamapps/workshop/content/322330/'+id])fs.rmSync(inside(this.config.game,relative),{recursive:true,force:true});
      fs.rmSync(this.pending(id),{recursive:true,force:true});fs.rmSync(this.receipt(id),{force:true});
      return {deleted:true,id};
    }finally{this.store.sharedBusy=false;}
  }
}





