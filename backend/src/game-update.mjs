import {spawn} from 'node:child_process';

// Steam crash reporters can inherit the pipes and outlive SteamCMD. Use the
// actual process exit status, allowing only a bounded time to drain its output.
export function runSteamUpdate(script,args,{cwd,env,onData=()=>{},timeoutMs=7200000,idleTimeoutMs=1800000,drainMs=1500,signal}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(script,args,{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
    let settled=false,exited=false,cancelled=false,exitCode=null,exitSignal=null,drainTimer,idleTimer;
    const finish=(error)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);clearTimeout(idleTimer);clearTimeout(drainTimer);signal?.removeEventListener('abort',cancel);
      child.stdout.destroy();child.stderr.destroy();
      if(error)reject(error);else resolve({code:exitCode,signal:exitSignal});
    };
    const cancel=()=>{
      cancelled=true;
      const error=Object.assign(Error('SteamCMD 更新已终止'),{code:'ECANCELED'});
      try{process.kill(-child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
      setTimeout(()=>{if(!settled){try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}finish(error);}},2500).unref();
    };
    if(signal?.aborted){cancel();return;}
    signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>{
      const error=Object.assign(Error('SteamCMD 更新超时，详情见 installation.log'),{code:'ETIMEDOUT'});
      try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}
      // Do not depend on close: a detached descendant may still own a pipe.
      finish(error);
    },timeoutMs);
    const armIdleTimer=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>{
      const error=Object.assign(Error('SteamCMD 长时间没有返回进度，详情见 installation.log'),{code:'ETIMEDOUT',idle:true});
      try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}
      finish(error);
    },idleTimeoutMs);};
    armIdleTimer();
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{armIdleTimer();onData(chunk);});child.stderr.on('data',chunk=>{armIdleTimer();onData(chunk);});
    child.once('error',finish);
    child.once('exit',(code,signal)=>{
      exited=true;exitCode=code;exitSignal=signal;clearTimeout(timer);
      drainTimer=setTimeout(()=>finish(cancelled?Object.assign(Error('SteamCMD 更新已终止'),{code:'ECANCELED'}):undefined),drainMs);
    });
    child.once('close',(code,signal)=>{
      if(!exited){exitCode=code;exitSignal=signal;}
      finish();
    });
  });
}

// Share SteamCMD's two successful outcomes between progress and completion.
export function gameUpdateOutcome(output) {
  for(const raw of output.split(/[\r\n]+/)) {
    const line=raw.replace(/\x1b\[[0-9;]*m/g,'').trim();
    const match=line.match(/^Success!\s*App\s*['"]?343050['"]?\s+(fully installed|already up to date)\.?$/i);
    if(match)return {upToDate:/already up to date/i.test(match[1])};
  }
  return null;
}

// SteamCMD prints stage-local percentages. Keep validation and download bytes
// separate so checking a cached depot is never reported as network throughput.
export class GameUpdateProgress {
  constructor() { this.pending='';this.phase='connecting';this.progress=null;this.downloadedBytes=null;this.totalBytes=null;this.bytesPerSecond=null;this.sample=null;this.logs=[]; }
  consume(text, now=Date.now()) {
    this.pending+=text;
    const lines=this.pending.split(/[\r\n]+/);this.pending=lines.pop().slice(-8192);
    for(const raw of lines)this.line(raw,now);
  }
  flush(now=Date.now()) { if(this.pending)this.line(this.pending,now);this.pending=''; }
  line(raw,now) {
    const line=raw.replace(/\x1b\[[0-9;]*m/g,'').trim();if(!line)return;
    if(this.logs.at(-1)!==line){this.logs.push(line.slice(0,400));if(this.logs.length>30)this.logs.shift();}
    const steam=line.match(/^\[\s*(\d+(?:\.\d+)?)%\s*\]\s*(.*?)(?:\s+\(([\d,]+)\s+of\s+([\d,]+)\s+KB\))?\.*$/i);
    const match=line.match(/progress:\s*([\d.]+)(?:\s*%?\s*\(\s*([\d,]+)\s*\/\s*([\d,]+)\s*\))?/i);
    const percent=steam?Number(steam[1]):match?Number(match[1]):null;
    const downloaded=steam?.[3]?Number(steam[3].replaceAll(',',''))*1024:match?.[2]?Number(match[2].replaceAll(',','')):null;
    const total=steam?.[4]?Number(steam[4].replaceAll(',',''))*1024:match?.[3]?Number(match[3].replaceAll(',','')):null;
    const stage=steam?.[2]||line;
    let phase=/checking for available updates|reconfigur/i.test(stage)?'connecting':/validat|verif/i.test(stage)?'verifying':/downloading|preallocating/i.test(stage)?'downloading':/download complete|staging|committing|installing|extracting|cleaning up|update complete/i.test(stage)?'installing':null;
    if(gameUpdateOutcome(line))phase='checking';
    if(phase&&phase!==this.phase){this.phase=phase;this.progress=null;this.downloadedBytes=null;this.totalBytes=null;this.bytesPerSecond=null;this.sample=null;}
    if(percent!==null&&Number.isFinite(percent)){
      this.progress=Math.max(0,Math.min(100,percent));
      if(this.phase==='downloading'&&downloaded!==null&&total>0){
        const bytes=downloaded;
        if(this.sample&&now>this.sample.time&&bytes>=this.sample.bytes)this.bytesPerSecond=(bytes-this.sample.bytes)*1000/(now-this.sample.time);
        this.sample={bytes,time:now};this.downloadedBytes=bytes;this.totalBytes=total;
      }
    }
  }
  snapshot(now=Date.now()) {
    return {phase:this.phase,progress:this.progress,downloadedBytes:this.downloadedBytes,totalBytes:this.totalBytes,bytesPerSecond:this.sample&&now-this.sample.time>6000?null:this.bytesPerSecond,logs:this.logs.slice()};
  }
}
