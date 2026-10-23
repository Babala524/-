import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ensureNative,requestDependencies,steamBootstrap} from '../src/native-dependencies.mjs';

async function fixture(handler,run){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feather-deps-'));
 const socketPath=path.join(directory,'deps.sock');
 const sockets=new Set(),server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));handler(socket);});
 await new Promise(resolve=>server.listen(socketPath,resolve));
 try{await run(socketPath);}finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});}
}
const linux={skip:process.platform==='win32'};
test('native dependency service receives only a fixed group and streams preparation',linux,()=>fixture(socket=>{
 socket.once('data',data=>{assert.equal(data.toString(),'map\n');socket.write('{"type":"progress","message":"正在准备地图"}\n');socket.end('{"type":"ready"}\n');});
},async socketPath=>{
 const progress=[];await requestDependencies('map',(...args)=>progress.push(args),{socketPath});
 assert.equal(progress[0][1],'正在准备地图');assert.equal(progress[0][2].phase,'dependencies');
}));
test('native dependency failures stay visible and can be retried',linux,()=>fixture(socket=>{
 socket.once('data',()=>socket.end('{"type":"error","message":"软件源暂不可用"}\n'));
},async socketPath=>{
 await assert.rejects(requestDependencies('game',()=>{},{socketPath}),/软件源暂不可用/);
 await assert.rejects(requestDependencies('game',()=>{},{socketPath}),/软件源暂不可用/);
}));
test('native dependency request rejects injected input before contacting the service',async()=>{
 await assert.rejects(requestDependencies('map\n/bin/sh'),/未知依赖类型/);
});
test('Docker and development do not contact the privileged helper',async()=>{
 await ensureNative({nativeDependencies:false},'game');
});
test('Valve bootstrap retries transient connections and keeps failures actionable',async()=>{
 let attempts=0;
 const content=Buffer.alloc(1024,1);
 const result=await steamBootstrap(async()=>{if(++attempts<3)throw Error('timeout');return new Response(content);},()=>{},async()=>{});
 assert.equal(attempts,3);assert.deepEqual(result,content);
 await assert.rejects(steamBootstrap(async()=>{throw Error('timeout');},()=>{},async()=>{}),/已重试 3 次/);
});
test('native dependency disconnect, malformed reply and timeout produce actionable errors',linux,async()=>{
 await fixture(socket=>socket.once('data',()=>socket.end()),async socketPath=>assert.rejects(requestDependencies('python',()=>{},{socketPath}),/中断/));
 await fixture(socket=>socket.once('data',()=>socket.end('invalid\n')),async socketPath=>assert.rejects(requestDependencies('python',()=>{},{socketPath}),/无效响应/));
 await fixture(()=>{},async socketPath=>assert.rejects(requestDependencies('python',()=>{},{socketPath,timeout:30}),/超时/));
});
