import crypto from 'node:crypto';
import fs from 'node:fs';
import { demand, inside, tail, Fault } from './core.mjs';
import { staticLuaTable, savedEntitySummary } from './lua.mjs';
import { savedMapFields } from './save-map.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const mapTargets={wasphive:'杀人蜂巢',killerbeehive:'杀人蜂巢',walrus_camp:'海象营地'};
export class Telemetry {
  constructor(runtime){this.runtime=runtime;this.cache=new Map();this.pending=new Map();this.assetCache=new Map();}
  invalidate(id,world){for(const key of this.cache.keys())if(key.startsWith(`${id}:${world}:`))this.cache.delete(key);this.assetCache.delete(`${id}:${world}`);}
  async clients(id,world){
    // Always query the current connections. Cached overview data cannot confirm
    // that a kick worked, and a player may still be on the character screen.
    const token='FP_'+crypto.randomBytes(10).toString('hex');
    const log=inside(this.runtime.store.cluster(id),`${world.directory}/server_log.txt`);
    await this.runtime.command(id,`--[[FEATHER_TELEMETRY]] local p={} for _,v in ipairs(GetPlayerClientTable() or {}) do if v.userid and v.userid~="" then p[#p+1]={userid=v.userid} end end;print("${token}",json.encode({players=p}))`,[world.directory]);
    const end=Date.now()+7000;
    while(Date.now()<end){
      await delay(150);
      for(const line of tail(log,262144).split(/\r?\n/)){
        const pos=line.indexOf(token+'\t');if(pos===-1)continue;
        let data;try{data=JSON.parse(line.slice(pos+token.length+1).trim());}catch{continue;}
        demand(Array.isArray(data.players)&&data.players.every(player=>typeof player.userid==='string'&&player.userid.length>0),'游戏未返回有效在线玩家名单',502);
        return data.players;
      }
    }
    throw new Fault(504,`世界 ${world.directory} 未返回在线玩家名单，无法确认移出结果`);
  }
  async read(id,world,map=false){
    const key=`${id}:${world.directory}:${map}`;
    const cached=this.cache.get(key);if(cached&&Date.now()-cached.time<(map?60000:4000))return cached.value;
    if(this.pending.has(key))return this.pending.get(key);
    const promise=this.collect(id,world,map).then(value=>{if(this.cache.size>256)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,{time:Date.now(),value});return value;}).finally(()=>this.pending.delete(key));
    this.pending.set(key,promise);return promise;
  }
  async collect(id,world,map){
    // 地图来自存档文件，不能依赖游戏控制台响应；控制台在世界加载中时
    // 经常会阻塞数秒，导致地图接口误报 504。先直接返回真实地形，生物
    // 统计由后续普通遥测请求补充。
    if(map){
      const saved=this.readSavedMap(id,world,[]);
      demand(saved,'存档尚未生成可读取的地图数据，请进入世界后重试',409);
      return {...saved,collectedAt:new Date().toISOString()};
    }
    const token='FP_'+crypto.randomBytes(10).toString('hex');
    const log=inside(this.runtime.store.cluster(id),`${world.directory}/server_log.txt`);
    const assetKey=`${id}:${world.directory}`,assetCached=this.assetCache.get(assetKey),readAssets=!assetCached||Date.now()-assetCached.time>60000;
    const mapAssets=readAssets?`local ok,ma=pcall(function() local gt=require("worldtiledefs");local names={} for k,v in pairs(WORLD_TILES) do names[v]=k end;local a={terrains={},atlases={},aliases={}};for _,v in ipairs(gt.minimap or {}) do local p=v[2];if p and names[v[1]] and #a.terrains<1024 then a.terrains[#a.terrains+1]={name=names[v[1]],texture=p.noise_texture,edge=p.texture_name,atlas=p.atlas,ocean=string.find(names[v[1]],"OCEAN",1,true)~=nil} end end;for _,list in ipairs(ModManager:GetPostInitData("MinimapAtlases") or {}) do for _,path in ipairs(list) do if #a.atlases<2048 then a.atlases[#a.atlases+1]=path end end end;local seen={};local count=0;for _,e in pairs(Ents or {}) do if e and e.prefab and not seen[e.prefab] and e.MiniMapEntity and e.MiniMapEntity.GetIcon and count<1024 then seen[e.prefab]=true;local icon=e.MiniMapEntity:GetIcon();if type(icon)=="string" and #icon<256 then a.aliases[e.prefab]=icon;count=count+1 end end end;return a end);if ok then mapassets=ma end;`:'';
    // Only fixed read-only game queries enter the console. No client supplied Lua is accepted.
    const state=`local p={} for _,v in ipairs(GetPlayerClientTable() or {}) do if v.userid and v.userid~="" then local e=LookupPlayerInstByUserID(v.userid);local x,y,z;if e then x,y,z=e.Transform:GetWorldPosition() end;p[#p+1]={userid=v.userid,name=v.name,prefab=v.prefab,admin=v.admin==true,playerage=v.playerage,localPlayer=e~=nil,x=x,z=z} end end;local wanted={wasphive="杀人蜂巢",killerbeehive="杀人蜂巢",walrus_camp="海象营地"};local creatures={["杀人蜂巢"]=0,["海象营地"]=0};local points={};for _,e in pairs(Ents or {}) do local key=e and e.prefab and wanted[e.prefab];if key then creatures[key]=(creatures[key] or 0)+1;local x,y,z;if e.Transform then x,y,z=e.Transform:GetWorldPosition() end;if x and z then points[#points+1]={kind=key,x=x,z=z} end end end;print("${token}",json.encode({kind="state",players=p,creatures=creatures,points=points,cycles=TheWorld.state.cycles,season=TheWorld.state.season,phase=TheWorld.state.phase,seasonDay=TheWorld.state.elapseddaysinseason}));`;
    // The game truncates a single log print at 4095 bytes. Ship larger asset
    // metadata as bounded hex chunks; never enlarge the normal state record.
    const assetOutput=`if mapassets then local encoded=json.encode(mapassets);if #encoded<=100000 then local total=math.ceil(#encoded/1200);for i=1,total do local part=string.sub(encoded,(i-1)*1200+1,i*1200):gsub(".",function(c)return string.format("%02x",string.byte(c)) end);print("${token}",json.encode({kind="mapasset",part=i,total=total,data=part})) end end end;`;
    const withAssets=state.replace('local p={}',`local mapassets;${mapAssets}${assetOutput}local p={}`);
    await this.runtime.command(id,`--[[FEATHER_TELEMETRY]] if TheWorld and TheWorld.Map then ${withAssets}print("${token}",json.encode({kind="done"})) end`,[world.directory]);
    const end=Date.now()+7000;
    while(Date.now()<end){
      await delay(150);
      const lines=tail(log,262144).split(/\r?\n/),data=[];
      for(const line of lines){const pos=line.indexOf(token+'\t');if(pos===-1)continue;try{data.push(JSON.parse(line.slice(pos+token.length+1).trim()));}catch{}}
      if(!data.some(item=>item.kind==='done'))continue;
      demand(!data.some(item=>item.kind==='error'),'地图尺寸超过预览限制',422);
      const state=data.find(item=>item.kind==='state');demand(state&&Array.isArray(state.players),'游戏未返回有效玩家数据',502);
      const chunks=data.filter(item=>item.kind==='mapasset');
      if(chunks.length&&chunks[0].total<=84&&chunks.length===chunks[0].total){
        chunks.sort((a,b)=>a.part-b.part);
        if(chunks.every((part,i)=>part.part===i+1&&part.total===chunks.length&&typeof part.data==='string'&&/^[a-f0-9]{0,2400}$/.test(part.data)))try{state.mapAssets=JSON.parse(Buffer.from(chunks.map(part=>part.data).join(''),'hex').toString('utf8'));}catch{}
      }
      if(state.mapAssets){if(this.assetCache.size>256)this.assetCache.delete(this.assetCache.keys().next().value);this.assetCache.set(assetKey,{time:Date.now(),value:state.mapAssets});}
      else if(assetCached&&Date.now()-assetCached.time<120000)state.mapAssets=assetCached.value;
      return {...state,collectedAt:new Date().toISOString()};
    }
    throw new Fault(504,`世界 ${world.directory} 未及时返回采集结果，可能正在启动或加载`);
  }
  readSavedMap(id,world){
    const base=inside(this.runtime.store.cluster(id),`${world.directory}/save/session`);if(!fs.existsSync(base))return null;
    const sessions=fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^[A-Fa-f0-9]{8,32}$/.test(e.name)).map(e=>({name:e.name,path:inside(base,e.name)})).sort((a,b)=>fs.statSync(b.path).mtimeMs-fs.statSync(a.path).mtimeMs);
    for(const session of sessions){
      const files=fs.readdirSync(session.path).filter(name=>/^\d{1,16}$/.test(name)).sort((a,b)=>Number(b)-Number(a));
      for(const name of files){
        const file=inside(session.path,name);let text,stat;
        try{stat=fs.statSync(file);if(!stat.isFile()||stat.size>128*1048576)continue;text=fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
        const fields=savedMapFields(text);if(!fields)continue;
        const width=/^\d+$/.test(fields.width)?Number(fields.width):0,height=/^\d+$/.test(fields.height)?Number(fields.height):0,encoded=fields.tiles?.match(/^["']([A-Za-z0-9+/=]+)["']$/)?.[1];
        if(!width||!height||width>2048||height>2048||!encoded)continue;
        const decoded=Buffer.from(encoded,'base64');if(decoded.length<8+width*height*2||decoded.subarray(0,4).toString()!=='VRSN')continue;
        // Skip the 8-byte version header; tile IDs are big-endian uint16.
        // Reading only the low byte corrupts newer terrains with IDs above 255.
        const tiles=Array.from({length:width*height},(_,i)=>decoded.readUInt16BE(8+i*2));
        const names={};
        try{for(const [name,value] of Object.entries(staticLuaTable('return '+fields.world_tile_map)))if(Number.isInteger(value)&&value>=0&&value<=65535)names[value]=name;}catch{continue;}
        if(!Object.keys(names).length)continue;
        // Some saves retain the 0x100 terrain flag on legacy tile IDs. The
        // live game's GetTileAtPoint returns the unflagged ID at these cells.
        // A directly defined uint16 ID always wins (e.g. MONKEY_GROUND=257).
        for(let i=0;i<tiles.length;i++)if(!names[tiles[i]]&&(tiles[i]&0x100)&&names[tiles[i]&~0x100])tiles[i]&=~0x100;
        const markers=[],creatures={'杀人蜂巢':0,'海象营地':0},entities=[],targetEntities=[];
        for(const match of text.matchAll(/tablefunctions\["ents_([a-zA-Z0-9_]+)_fn"\]\s*=\s*function\(\)\s*(return [\s\S]*?)\r?\nend/g)){
          const prefab=match[1],label=mapTargets[prefab];
          if(!label&&entities.length>=50000)continue;
          try{
            const saved=savedEntitySummary(match[2]);
            if(label){
              if(creatures[label]!==null)creatures[label]+=saved.count;
              for(const entity of saved.positions){markers.push({kind:label,x:entity.x,z:entity.z});targetEntities.push({prefab,...entity});}
            }else for(const entity of saved.positions){entities.push({prefab,...entity});if(entities.length>=50000)break;}
          }catch{if(label)creatures[label]=null;}
        }
        // Keep target markers even in dense worlds whose vegetation reaches the display limit.
        entities.unshift(...targetEntities.slice(0,20000));entities.length=Math.min(50000,entities.length);
        let roads=[];
        if(fields.roads)try{const value=staticLuaTable('return '+fields.roads);if(value&&typeof value==='object')roads=Object.values(value);}catch{}
        let savedMods=null;
        const modsMatch=text.match(/tablefunctions\["mods_fn"\]\s*=\s*function\(\)\s*(return [\s\S]*?)\r?\nend/);
        if(modsMatch)try{savedMods=Object.entries(staticLuaTable(modsMatch[1])).filter(([key,value])=>/^workshop-\d{6,20}$/.test(key)&&value?.active===true).map(([key])=>key.slice(9));}catch{}
        return {width,height,names,tiles,markers,creatures,entities,roads,savedMods,savedAt:stat.mtime.toISOString()};
      }
    }
    return null;
  }

}

