import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {exec, inside, Fault} from './core.mjs';

export const dependencySocket='/run/feather-panel-dependencies.sock';
const pending=new Map();

export async function steamBootstrap(fetcher=fetch,report=()=>{},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
  for(let attempt=1;attempt<=3;attempt++){
    report(null,`首次使用：正在下载 SteamCMD（${attempt}/3）`,{phase:'dependencies',dependency:'steam'});
    try{
      const response=await fetcher('https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',{signal:AbortSignal.timeout(60000)});
      if(!response.ok||!response.body)throw Error('下载失败');
      let bytes=0;const chunks=[];
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>16*1048576)throw Error('下载大小异常');chunks.push(chunk);}
      if(bytes<1000)throw Error('下载内容不完整');
      return Buffer.concat(chunks);
    }catch(error){if(attempt===3)throw new Fault(502,'连接 Valve 下载 SteamCMD 失败，已重试 3 次；运行库已保留，请稍后再点击更新游戏');await wait(attempt*1000);}
  }
}

// Only native installations opt in. Docker and development keep their existing runtimes.
export async function ensureNative(config,group,report=()=>{}) {
  if(!config.nativeDependencies)return;
  if(!['python','map','game'].includes(group))throw new Fault(400,'未知依赖类型');
  const key=dependencySocket+':'+group;
  if(pending.has(key))return pending.get(key);
  const job=requestDependencies(group,report).finally(()=>pending.delete(key));
  pending.set(key,job);return job;
}

export function requestDependencies(group,report=()=>{},{socketPath=dependencySocket,timeout=1200000}={}) {
  if(!['python','map','game'].includes(group))return Promise.reject(new Fault(400,'未知依赖类型'));
  return new Promise((resolve,reject)=>{
    let buffer='',settled=false;
    const connection=net.createConnection(socketPath);
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);connection.destroy();error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Fault(504,'依赖准备超时，可稍后重试；通过 sudo featherpanel dependencies 查看安装日志')),timeout);
    connection.on('connect',()=>connection.write(group+'\n'));
    connection.setEncoding('utf8');
    connection.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>65536)return finish(new Fault(502,'依赖服务响应过大'));
      let split;while((split=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,split);buffer=buffer.slice(split+1);
        try{
          const detail=JSON.parse(line);
          if(detail.type==='ready')return finish();
          if(detail.type==='error')return finish(new Fault(503,String(detail.message||'依赖安装失败')));
          if(detail.type==='progress')report(null,String(detail.message||'正在准备运行环境'),{phase:'dependencies',dependency:group});
        }catch(error){return finish(new Fault(502,'依赖服务返回了无效响应'));}
      }
    });
    connection.on('error',()=>finish(new Fault(503,'原生依赖服务不可用，请运行 sudo featherpanel dependencies 检查')));
    connection.on('end',()=>finish(new Fault(503,'依赖准备中断，请查看依赖服务日志后重试')));
  });
}

export async function ensureSteam(config,report=()=>{}) {
  await ensureNative(config,'game',report);
  const script=inside(config.steam,'steamcmd.sh');
  if(fs.existsSync(script)||!config.nativeDependencies)return;
  const key=config.steam+':steam';if(pending.has(key))return pending.get(key);
  const job=(async()=>{
    const bootstrap=await steamBootstrap(fetch,report);
    const temporary=inside(config.data,'tmp/steam-bootstrap-'+randomUUID());fs.mkdirSync(temporary,{recursive:true});
    try{
      const archive=path.join(temporary,'steam.tar.gz'),folder=path.join(temporary,'files');
      fs.writeFileSync(archive,bootstrap,{mode:0o600});fs.mkdirSync(folder);
      await exec('tar',['-xzf',archive,'-C',folder,'--no-same-owner'],{timeout:30000});
      for(const file of ['steamcmd.sh','linux32/steamcmd']){
        if(!fs.existsSync(inside(folder,file)))throw new Fault(502,'SteamCMD 下载内容不完整');
      }
      // Extraction and installation run as the unprivileged panel account.
      fs.mkdirSync(config.steam,{recursive:true});fs.cpSync(folder,config.steam,{recursive:true,dereference:false});
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  })().finally(()=>pending.delete(key));
  pending.set(key,job);return job;
}
