import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {exec, root, sha, Fault, demand} from './core.mjs';
import {ModMapAssets} from './mod-map-assets.mjs';

// Rendering runs outside Node's event loop. Deduplicate identical requests and
// serialize different worlds so map previews cannot exhaust a small game host.
export class MapRenderer {
  constructor(config) {this.config=config;this.pending=new Map();this.cache=new Map();this.queue=Promise.resolve();this.modAssets=new ModMapAssets(config);}
  async render(data, options = {}) {
    const quality = options.quality === 'preview' ? 'preview' : 'full';
    // The dashboard and dialog initially show a small image. The full map is
    // fetched only when needed for zoom/download, so the first paint stays
    // responsive even on a remote browser.
    const scaleLimit = quality === 'preview' ? 3 : 8;
    const entityLimit = quality === 'preview' ? 12000 : 50000;
    const modAssets=this.modAssets.collect(data.mods||[],data.liveMapAssets);
    // Saved entity positions are stable while the world is unchanged. Live
    // marker polling should not invalidate an otherwise identical terrain
    // render when saved entities already cover the map.
    const cacheMarkers=Array.isArray(data.entities)&&data.entities.length?[]:data.markers;
    const input=JSON.stringify({width:data.width,height:data.height,names:data.names,tiles:data.tiles,entities:data.entities,roads:data.roads,markers:cacheMarkers,modAssets,scaleLimit,entityLimit});
    const assets=path.join(this.config.game||'', 'data');
    let stamp;
    try {stamp=await fs.stat(path.join(assets,'databundles/scripts.zip'));}
    catch {throw new Fault(409,'缺少游戏原版地图资源，请先安装或更新游戏服务端');}
    const key=sha(input+stamp.mtimeMs+':mod-assets-v3:'+quality);
    if(this.cache.has(key))return this.cache.get(key);
    if(this.pending.has(key))return this.pending.get(key);
    demand(this.pending.size<4,'地图渲染任务较多，请稍后重试',503);
    const job=this.queue.catch(()=>{}).then(()=>this.run(assets,input,quality)).then(result=>{
      // Two high resolution PNGs are enough for the usual forest/caves pair.
      // Keep both quality levels for forest/caves so opening the large viewer
      // does not evict the fast dashboard previews (and vice versa).
      while(this.cache.size>=6)this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key,result);return result;
    }).finally(()=>this.pending.delete(key));
    this.pending.set(key,job);this.queue=job;return job;
  }
  async run(assets,input,quality='full') {
    const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'feather-map-'));
    try {
      const source=path.join(temporary,'map.json'),destination=path.join(temporary,quality==='preview'?'map.webp':'map.png');
      await fs.writeFile(source,input,{mode:0o600});
      let stdout;
      try {({stdout}=await exec(this.config.python||'python3',[path.join(root,'backend/scripts/render_map.py'),assets,source,destination],{timeout:60000,killSignal:'SIGKILL',maxBuffer:1048576,windowsHide:true}));}
      catch(error) {
        if(error.killed)throw new Fault(504,'原版地图渲染超时，请稍后刷新重试');
        if(/PIL|No module named/.test(error.stderr||''))throw new Fault(503,'地图渲染依赖缺失，请更新面板 Docker 镜像');
        throw new Fault(422,'原版地图渲染失败：'+String(error.stderr||error.message).trim().slice(0,220));
      }
      const meta=JSON.parse(stdout),png=await fs.readFile(destination);
      const pngHeader=png.subarray(0,8).toString('hex')==='89504e470d0a1a0a';
      const webpHeader=png.subarray(0,4).toString('ascii')==='RIFF'&&png.subarray(8,12).toString('ascii')==='WEBP';
      demand(meta.renderer==='klei-textures-v1'&&(quality==='preview'?webpHeader:pngHeader),'游戏地图渲染结果无效',502);
      return {...meta,quality,image:`data:image/${quality==='preview'?'webp':'png'};base64,`+png.toString('base64')};
    } finally {await fs.rm(temporary,{recursive:true,force:true});}
  }
}
