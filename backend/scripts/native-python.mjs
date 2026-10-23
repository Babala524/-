import {spawn} from 'node:child_process';
import {ensureNative} from '../src/native-dependencies.mjs';

try{
  // The trusted helper only receives the fixed group, never Python arguments.
  const map=process.argv[2]?.endsWith('/render_map.py')||process.argv[2]?.endsWith('/mod_icon.py');
  await ensureNative({nativeDependencies:true},map?'map':'python');
  const child=spawn('/usr/bin/python3',process.argv.slice(2),{stdio:'inherit'});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('close',(code,signal)=>{process.exitCode=code??1;});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
}catch(error){console.error(error.message);process.exitCode=1;}
