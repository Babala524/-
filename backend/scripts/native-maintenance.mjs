import fs from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

export function readEnvironment(file='/etc/feather-panel.env'){
  const values={};for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    if(!line.trim()||line.trimStart().startsWith('#'))continue;
    const match=line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);if(!match)throw Error('原生环境文件格式不合法');
    let value=match[2];if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    values[match[1]]=value;
  }return values;
}
export async function maintenance(action,stateFile,env=readEnvironment()){
  const port=Number(env.FEATHER_PORT||80),host=env.FEATHER_HOST==='::'?'[::1]':'127.0.0.1';
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('面板端口不合法');
  const base=`http://${host}:${port}`;
  if(action==='health'){
    for(let n=0;n<45;n++){try{const r=await fetch(base+'/healthz',{signal:AbortSignal.timeout(2000)});if(r.ok&&(await r.json()).service==='FeatherPanel')return;}catch{}await wait(1000);}
    throw Error('面板健康检查超时');
  }
  const token=env.FEATHER_ADMIN_TOKEN||fs.readFileSync((env.FEATHER_DATA||'/var/lib/feather-panel')+'/admin-token','utf8').trim();
  const api=async(route,body)=>{
    const r=await fetch(base+'/api'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
    const json=await r.json();if(!r.ok)throw Error(json.error||`请求失败 ${r.status}`);return json.data;
  };
  const task=async(route,body)=>{
    const result=await api(route,body),id=result.taskID;if(!id)throw Error('控制接口未返回任务');
    for(let n=0;n<180;n++){const current=await api('/tasks/'+id);if(current.state==='succeeded')return;if(['failed','cancelled'].includes(current.state))throw Error(current.error||'控制任务失败');await wait(1000);}
    throw Error('控制任务超时');
  };
  if(action==='stop'){
    const states=[];for(const room of await api('/rooms')){
      const worlds=(await api('/rooms/'+room.id+'/worlds')).worlds;
      states.push({room:room.id,worlds:worlds.filter(w=>w.running).map(w=>w.directory)});
    }
    fs.writeFileSync(stateFile,JSON.stringify(states),{mode:0o600});
    for(const state of states)if(state.worlds.length)await task('/rooms/'+state.room+'/control',{action:'stop'});
    return states;
  }
  if(action==='restore'){
    const states=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    for(const state of states)for(const worldID of state.worlds)await task('/rooms/'+state.room+'/worlds/control',{action:'start',worldID});
    return states;
  }
  throw Error('未知原生维护操作');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href){
  maintenance(process.argv[2],process.argv[3]).catch(error=>{console.error(error.message);process.exitCode=1;});
}
