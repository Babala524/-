import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { demand, Fault, inside, walk, exec, jsonRead } from './core.mjs';
import { contentProgress } from './workshop-state.mjs';

export async function downloadLegacy(config,id,slot,report,fetcher=fetch) {
  const info=jsonRead(inside(config.data,'workshop-meta/'+id+'.json'),{});
  let url;try{url=new URL(info.file_url);}catch{return null;}
  if(url.protocol!=='https:'||!/(^|\.)(steamusercontent\.com|steamstatic\.com|akamaihd\.net)$/.test(url.hostname))return null;
  const base=inside(config.data,'workshop-http/worker-'+slot);fs.mkdirSync(base,{recursive:true});
  const archive=inside(base,'download.bin'),extracted=inside(base,'extracted');
  fs.rmSync(archive,{force:true});fs.rmSync(extracted,{recursive:true,force:true});
  const controller=AbortSignal.timeout(900000);
  const response=await fetcher(url.href,{signal:controller,redirect:'error'});demand(response.ok&&response.body,'工坊文件下载失败',502);
  const total=Number(response.headers.get('content-length'))||Number(info.fileSize)||null;
  let received=0,last=0;const fd=fs.openSync(archive,'w',0o600);
  try{for await(const chunk of response.body){received+=chunk.length;demand(received<=config.extractLimit,'模组下载文件超过限制',413);fs.writeSync(fd,chunk);
    if(Date.now()-last>300){last=Date.now();report(total?Math.min(99,received/total*100):null,'正在下载工坊文件',{stage:'downloading',downloadedBytes:received,totalBytes:total,progressSource:'http-bytes'});}
  }}finally{fs.closeSync(fd);}
  demand(!Number(response.headers.get('content-length'))||received===Number(response.headers.get('content-length')),'下载文件不完整',502);
  report(100,'文件已下载，正在解包验证',{stage:'extracting',downloadedBytes:received,totalBytes:received,progressSource:'http-bytes'});
  await exec(config.python,[path.join(config.root,'backend/scripts/archive.py'),'mod-extract',archive,extracted,String(config.extractLimit)],{timeout:120000,maxBuffer:1048576});
  demand(fs.existsSync(inside(extracted,'modinfo.lua')),'工坊文件缺少 modinfo.lua',502);walk(extracted);return extracted;
}

function permanentWorkshopError(message) {
  return /(failure:\s*(?:no subscription|access denied|file not found)|private item|invalid workshop item|item.*does not exist)/i.test(String(message));
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function ensureWritable(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const probe=path.join(directory,'.write-probe-'+process.pid);
  try { fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); fs.writeFileSync(probe,'ok',{flag:'wx'}); }
  catch { throw new Fault(507, `模组下载目录不可写：${directory}`); }
  finally { fs.rmSync(probe,{force:true}); }
}

// Always ask Steam to validate, including when a previous attempt left modinfo.lua.
// That single file does not prove that the rest of a workshop item is complete.
export async function retryWorkshop(run, report=()=>{}, {wait=sleep, attempts=3}={}) {
  for(let attempt=1;attempt<=attempts;attempt++){
    if(attempt>1)report(null,`Steam 工坊下载重试 ${attempt}/${attempts}，继续使用已完成缓存`,{stage:'retrying',attempt});
    try{return await run(attempt);}
    catch(error){
      if(error.permanent||error.status===507)throw error;
      if(attempt===attempts){const failure=new Fault(error.status||502,`Steam 工坊下载失败，已尝试 ${attempts} 次；已保留缓存，可稍后重试。${error.message}`);throw failure;}
      await wait(attempt*3000);
    }
  }
}

// Each worker owns SteamCMD's writable runtime, home and workshop manifest.
// SteamCMD processes cannot safely share those directories.
async function runSteamWorkshopDownload({ runtime, home, game, id, report }) {
  report(null, '正在连接 Steam，等待下载数据', { stage: 'connecting' });
  await new Promise((resolve, reject) => {
    const child = spawn(inside(runtime, 'steamcmd.sh'), [
      '+force_install_dir', game, '+login', 'anonymous',
      '+workshop_download_item', '322330', id, 'validate', '+quit'
    ], { cwd: runtime, env: { ...process.env, HOME: home }, detached:true, stdio: ['ignore','pipe','pipe'] });
    let tail = '', pending = '', failure = null, lastMessage = '', logTotal = null, lastBytes = -1, steamFailure='', completed=false;
    const emit=(percent,message,stage)=>{const key=stage+':'+percent+':'+message;if(key!==lastMessage){lastMessage=key;report(percent,message,{stage});}};
    const timeout = setTimeout(() => { failure = new Fault(504, 'Steam 下载超时，请重试');try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');} }, 900000);
    const output = chunk => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-8000);
      if(/ERROR!|Failure:/i.test(text))steamFailure=(steamFailure+text).slice(-4000);
      if(new RegExp('Success\\. Downloaded item '+id+'\\b').test(tail))completed=true;
      pending += text;
      const lines = pending.split(/[\r\n]+/); pending = lines.pop().slice(-4096);
      for (const line of lines) {
        const percent = line.match(/(?:progress\s*:\s*|downloading[^\r\n]*?)(\d+(?:\.\d+)?)\s*%/i);
        if (percent) { const value=Math.max(0,Math.min(100,Number(percent[1])));emit(value,'Steam 正在下载 '+value.toFixed(1)+'%','downloading'); }
        else if (/Downloading item/i.test(line)) emit(null,'正在下载模组，Steam 尚未返回百分比','downloading');
        else if (/Success\. Downloaded item/i.test(line)) emit(100,'下载完成，正在验证文件','verifying');
        else if (/Downloading update|Installing update|Verifying installation/i.test(line)) emit(null,'正在初始化 SteamCMD，首次下载需要稍候','initializing');
      }
    };
    child.stdout.on('data', output); child.stderr.on('data', output);
    const bootstrap=inside(home,'Steam/logs/bootstrap_log.txt');
    const content=inside(home,'Steam/logs/content_log.txt');
    let contentOffset=fs.existsSync(content)?fs.statSync(content).size:0;
    let offset=fs.existsSync(bootstrap)?fs.statSync(bootstrap).size:0;
    const monitor=setInterval(()=>{try{
      if(fs.existsSync(content)){
        const size=fs.statSync(content).size;
        if(size>contentOffset){const fd=fs.openSync(content,'r'),buffer=Buffer.alloc(Math.min(size-contentOffset,16384));try{fs.readSync(fd,buffer,0,buffer.length,Math.max(contentOffset,size-buffer.length));}finally{fs.closeSync(fd);}contentOffset=size;
          const progress=contentProgress(buffer.toString());if(progress){logTotal=progress.totalBytes;report(progress.progress,'正在下载 '+progress.progress.toFixed(1)+'%',{stage:'downloading',...progress});}
        }
      }
      if(!fs.existsSync(bootstrap))return;
      const size=fs.statSync(bootstrap).size;if(size<=offset)return;
      const fd=fs.openSync(bootstrap,'r'),buffer=Buffer.alloc(Math.min(size-offset,8192));
      try{fs.readSync(fd,buffer,0,buffer.length,Math.max(offset,size-buffer.length));}finally{fs.closeSync(fd);}offset=size;
      const updates=[...buffer.toString().matchAll(/Downloading update \((\d+) of (\d+) KB\)/g)];
      if(updates.length){const match=updates.at(-1),value=Math.min(100,Number(match[1])/Number(match[2])*100);emit(value,'首次初始化 SteamCMD：'+value.toFixed(1)+'%','initializing');}
      if(logTotal){
        try{
          const root=inside(game,'steamapps/workshop/downloads/322330');
          let bytes=0;for(const file of walk(root))bytes+=fs.statSync(file).size;
          if(bytes!==lastBytes){lastBytes=bytes;const progress=Math.min(99,bytes/logTotal*100);report(progress,'正在下载 '+progress.toFixed(1)+'%',{stage:'downloading',downloadedBytes:bytes,totalBytes:logTotal,progressSource:'steam-files'});}
        }catch{}
      }
    }catch{}},500);
    child.once('error', error => { clearTimeout(timeout);clearInterval(monitor); reject(new Fault(502, '无法启动 SteamCMD：' + error.code)); });
    child.once('close', code => {
      clearTimeout(timeout);
      clearInterval(monitor);
      if (failure) return reject(failure);
      if (code !== 0 || steamFailure || /ERROR!.*(?:Download|Failed|Timeout)/i.test(tail) || !completed) {
        const detail=steamFailure||tail;
        const error=new Fault(502, permanentWorkshopError(detail)?'该模组不存在、未公开或当前账号无法访问':/I\/O Operation Failed/i.test(detail)?'Steam 返回 I/O Operation Failed，下载未通过校验':'Steam 工坊下载未确认成功');
        error.permanent=permanentWorkshopError(detail); return reject(error);
      }
      resolve();
    });
  });
}

export async function downloadWorkshop(config, id, slot, report) {
  try{const source=await downloadLegacy(config,id,slot,report);if(source)return source;}catch{report(null,'直接下载未完成，切换 SteamCMD 重试',{stage:'connecting'});}
  const worker = inside(config.data, 'workshop-workers/worker-' + slot);
  fs.mkdirSync(worker, { recursive: true });
  const runtime = inside(worker, 'steamcmd'), home = inside(worker, 'home'), game = inside(worker, 'download');
  if (!fs.existsSync(inside(runtime, 'steamcmd.sh'))) {
    fs.mkdirSync(runtime, { recursive: true });
    fs.cpSync(config.steam, runtime, { recursive: true, filter: source => !['logs','dumps','appcache','userdata'].includes(path.basename(source)) });
  }
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(game, { recursive: true });
  ensureWritable(worker); ensureWritable(home); ensureWritable(game);
  // Keep Steam's workshop tree between attempts. Steam can resume a partial
  // download; deleting it here turned a short CDN interruption into a full
  // restart and made archive restoration needlessly fragile.
  const sourceRoot=inside(game,'steamapps/workshop/content/322330'); ensureWritable(sourceRoot); let source=inside(sourceRoot,id);
  await retryWorkshop(()=>runSteamWorkshopDownload({runtime,home,game,id,report}),report);
  if(fs.existsSync(source)&&!fs.existsSync(inside(source,'modinfo.lua'))){
    const archives=fs.readdirSync(source).filter(name=>/^\d+_legacy\.bin$/.test(name));
    if(archives.length===1){
      report(null,'正在解包旧版 Steam 工坊模组',{stage:'extracting'});
      const extracted=inside(game,'legacy-extracted');fs.rmSync(extracted,{recursive:true,force:true});
      try{await exec(config.python,[path.join(config.root,'backend/scripts/archive.py'),'mod-extract',inside(source,archives[0]),extracted,String(config.extractLimit)],{timeout:120000,maxBuffer:1048576});}
      catch{throw new Fault(502,'旧版模组包无法安全解压，请检查模组文件后重试');}
      source=extracted;
    }
  }
  demand(fs.existsSync(inside(source, 'modinfo.lua')), 'SteamCMD 尚未下载到完整模组文件', 502);
  walk(source);
  return source;
}
