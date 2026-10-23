import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

// systemd passes one local socket on stdin/stdout. No shell text, file path,
// package name or environment from the panel is ever accepted by this helper.
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const fail=message=>{send({type:'error',message});process.exitCode=1;};
if(process.getuid?.()!==0){fail('依赖服务必须由 systemd 以 root 运行');process.exit(1);}
let input='';
const timer=setTimeout(()=>{fail('依赖请求超时');process.exit(1);},5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  input+=chunk;
  if(input.length>32){clearTimeout(timer);fail('无效的依赖请求');process.exit(1);}
  if(!input.includes('\n'))return;
  clearTimeout(timer);process.stdin.pause();
  if(!/^(python|map|game)\n$/.test(input)){fail('无效的依赖请求');process.exit(1);}
  const group=input.trim();
  const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'install-dependencies.sh');
  const child=spawn('/bin/bash',[script,group],{env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8',DEBIAN_FRONTEND:'noninteractive'},stdio:['ignore','pipe','pipe'],detached:true});
  let output='',last=0,done=false;
  const timeout=setTimeout(()=>{if(done)return;try{process.kill(-child.pid,'SIGTERM');}catch{}},18*60*1000);
  timeout.unref();
  const emit=chunk=>{
    const text=String(chunk);output=(output+text).slice(-4000);process.stderr.write(text);
    if(Date.now()-last>1000){last=Date.now();send({type:'progress',message:group==='game'?'首次使用：正在准备 screen 和游戏运行库':'首次使用：正在准备 Python'+(group==='map'?' 和地图图像库':'')});}
  };
  child.stdout.on('data',emit);child.stderr.on('data',emit);
  child.on('error',()=>{done=true;clearTimeout(timeout);fail('无法启动依赖安装程序，请查看依赖服务日志');process.stdout.end(()=>process.exit(1));});
  child.on('close',code=>{if(done)return;done=true;clearTimeout(timeout);if(code===0)send({type:'ready'});else fail('依赖安装失败，请稍后重试；日志：sudo featherpanel dependencies');process.stdout.end(()=>process.exit(code===0?0:1));});
});
process.stdout.on('error',()=>{});
