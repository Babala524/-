import fs from 'node:fs';
import path from 'node:path';
import {inside, sha} from './core.mjs';
import {parseLua, staticLuaTable} from './lua.mjs';

const unknown=Symbol('dynamic'), nameOf=node=>node?.type==='Identifier'?node.name:node?.type==='MemberExpression'?nameOf(node.base)+'.'+node.identifier.name:'';
const readable=value=>typeof value==='string'&&value.length<=4096;

// Read registration metadata, never execute Lua or provide file/network calls
// to a mod. Unknown expressions stay unknown rather than becoming guessed IDs.
export class ModMapAssets {
  constructor(config) {this.config=config;this.cache=new Map();this.scanCache=new Map();}
  collect(mods=[],live=null) {
    const manifest={terrains:[],atlases:[],aliases:{},overrides:[],orders:[],warnings:[],mods:[]},stamp=[];
    const addWarning=message=>{if(manifest.warnings.length<24&&!manifest.warnings.includes(message))manifest.warnings.push(message);};
    if(mods.length>100)addWarning('启用模组超过 100 个，部分地图资源未读取');
    for(const mod of mods.filter(mod=>mod.enabled!==false).slice(0,100)) {
      if(!/^\d{6,20}$/.test(String(mod.id)))continue;
      let folder;try{folder=inside(this.config.game,`mods/workshop-${mod.id}`);}catch{addWarning(`模组 ${mod.id} 的资源路径不可读取`);continue;}
      if(!fs.existsSync(folder)){addWarning(`模组 ${mod.id} 尚未安装，地图素材缺失`);continue;}
      let files;
      let folderStamp=0;
      try{folderStamp=fs.statSync(folder).mtimeMs;}catch{addWarning(`模组 ${mod.id} 资源目录无法读取`);continue;}
      const scanKey=folder,scanned=this.scanCache.get(scanKey);
      // Directory mtime changes when workshop updates add/remove files. Keep
      // the index briefly so preview + full-image requests reuse one scan.
      if(scanned&&scanned.folderStamp===folderStamp&&Date.now()-scanned.time<60000){
        // Refresh metadata: rewriting a texture does not change directory mtime.
        files=scanned.files.map(item=>{
          try{const stat=fs.statSync(inside(folder,item.relative));return {...item,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs};}
          catch{return {...item,size:-1,mtime:0,ctime:0};}
        });
      } else {
        files=[];let visited=0;
        const scan=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
          if(++visited>30000)throw Error('文件数超过限制');
          if(entry.isSymbolicLink())continue;
          const file=path.join(dir,entry.name);
          if(entry.isDirectory())scan(file);
          else if(entry.isFile()&&/\.(lua|xml|tex)$/i.test(entry.name)){const stat=fs.statSync(file);files.push({file,relative:path.relative(folder,file).split(path.sep).join('/'),size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs});}
        }};
        try{scan(folder);}catch{addWarning(`模组 ${mod.id} 资源扫描未完成`);continue;}
        files.sort((a,b)=>a.relative.localeCompare(b.relative));
        while(this.scanCache.size>=100)this.scanCache.delete(this.scanCache.keys().next().value);
        this.scanCache.set(scanKey,{folderStamp,time:Date.now(),files});
      }
      const key=sha(JSON.stringify([folder,mod.config||{},files]));stamp.push(key);
      let found=this.cache.get(key);
      if(!found) {
        found=extract(folder,files,mod);
        while(this.cache.size>=100)this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key,found);
      }
      manifest.mods.push(String(mod.id));
      for(const property of ['terrains','atlases','overrides','orders'])manifest[property].push(...found[property]);
      Object.assign(manifest.aliases,found.aliases);
      found.warnings.forEach(addWarning);
    }
    // Dynamic registration is already resolved by the running game. Accept
    // only paths belonging to the original game or this snapshot's mod set.
    if(live&&typeof live==='object') {
      const permitted=manifest.mods.map(id=>({id,base:path.resolve(this.config.game,`mods/workshop-${id}`)}));
      const resolve=value=>{
        if(!readable(value))return null;
        let clean=value.replaceAll('\\','/');
        if(clean.includes('\0'))return null;
        const candidates=path.isAbsolute(clean)?[clean]:[path.resolve(this.config.game,'data',clean),path.resolve(this.config.game,clean),path.resolve(this.config.game,'data',clean.replace(/^data\//,'')),...permitted.map(m=>path.resolve(m.base,clean))];
        for(const target of candidates)for(const base of [path.resolve(this.config.game,'data'),...permitted.map(m=>m.base)]){
          const relative=path.relative(base,target);
          if(relative.startsWith('..')||path.isAbsolute(relative))continue;
          try{const file=inside(base,relative);if(fs.existsSync(file)&&fs.statSync(file).isFile())return file;}catch{}
        }
        return null;
      };
      let runtimeCount=0;
      for(const [order,item] of (Array.isArray(live.terrains)?live.terrains:[]).slice(0,1024).entries()) {
        if(!readable(item.name)||!item.texture)continue;
        const texture=resolve(item.texture);if(!texture){addWarning(`运行中地形 ${item.name} 的地图材质无法读取`);continue;}
        const mod=permitted.find(m=>texture.startsWith(m.base+path.sep));
        const existing=manifest.terrains.findIndex(t=>t.name===item.name);
        const entry={name:item.name,texture,edge:resolve(item.edge),atlas:resolve(item.atlas),ocean:item.ocean===true,mod:mod?.id||'runtime',runtime:true,order};
        if(existing>=0)manifest.terrains[existing]=entry;else manifest.terrains.push(entry);
        // A static branch may be inactive. The game's actual registration wins.
        manifest.overrides=manifest.overrides.filter(v=>v.name!==item.name);
        runtimeCount++;
      }
      for(const file of (Array.isArray(live.atlases)?live.atlases:[]).slice(0,2048)){const resolved=resolve(file);if(resolved&&!manifest.atlases.includes(resolved))manifest.atlases.push(resolved);}
      for(const [prefab,icon]of Object.entries(live.aliases||{}).slice(0,4096))if(/^[\w-]{1,160}$/.test(prefab)&&readable(icon))manifest.aliases[prefab]=icon;
      manifest.runtimeResolved=runtimeCount>0;
    }
    manifest.signature=sha(JSON.stringify([stamp,manifest]));return manifest;
  }
}

function extract(folder,files,mod) {
  const result={terrains:[],atlases:[],aliases:{},overrides:[],orders:[],warnings:[]};
  const fileIndex=new Map(files.map(item=>[item.relative,item])),env=new Map([['MODROOT',folder.split(path.sep).join('/')+'/'],['modname',`workshop-${mod.id}`]]);
  let budget=200000,sourceFile='',sourceIcons=new Set(),functionIcons=new Map(),currentFunction=null;
  const warning=message=>{const text=`模组 ${mod.id}：${message}`;if(result.warnings.length<8&&!result.warnings.includes(text))result.warnings.push(text);};
  function asset(value,type='tex') {
    if(!readable(value)||value.includes('\0'))return null;
    let clean=value.replaceAll('\\','/');
    const prefix=folder.split(path.sep).join('/')+'/';if(clean.startsWith(prefix))clean=clean.slice(prefix.length);
    if(/^(?:[A-Za-z]:|\/)|(?:^|\/)\.\.(?:\/|$)/.test(clean))return null;
    clean=clean.replace(/^\.\//,'');
    if(!clean.endsWith('.'+type))clean=clean.replace(/\.(tex|xml)$/,'')+'.'+type;
    const candidates=[clean,`levels/${type==='xml'?'tiles':'textures'}/${clean}`,`levels/tiles/${clean}`];
    for(const candidate of candidates)if(fileIndex.has(candidate))return inside(folder,candidate);
    // Original assets may be referenced by their ordinary game path.
    for(const candidate of candidates){const file=inside(path.join(configGame(folder),'data'),candidate);if(fs.existsSync(file))return file;}
    return null;
  }
  const mark=()=>{if(--budget<0)throw Error('地图定义计算超过限制');};
  const stringLiteral=node=>{try{return staticLuaTable('return {'+node.raw+'}')[0];}catch{return unknown;}};
  function value(node,scope=env) {
    mark();if(!node)return unknown;
    if(node.type==='StringLiteral')return stringLiteral(node);
    if(node.type==='NumericLiteral'||node.type==='BooleanLiteral')return node.value;
    if(node.type==='NilLiteral')return null;
    if(node.type==='Identifier')return scope.has(node.name)?scope.get(node.name):unknown;
    if(node.type==='TableConstructorExpression'){
      const out=Object.create(null);let i=0;
      for(const field of node.fields){const key=field.type==='TableValue'?++i:field.type==='TableKeyString'?field.key.name:value(field.key,scope);if(key!==unknown)out[key]=value(field.value,scope);}
      return out;
    }
    if(node.type==='MemberExpression'||node.type==='IndexExpression') {
      const baseName=nameOf(node.base),key=node.type==='MemberExpression'?node.identifier.name:value(node.index,scope);
      if(/(?:^|\.)(?:WORLD_TILES|GROUND|TileRanges)$/.test(baseName)&&readable(key))return key;
      const base=value(node.base,scope);return base&&typeof base==='object'&&Object.hasOwn(base,key)?base[key]:unknown;
    }
    if(node.type==='BinaryExpression') {
      const a=value(node.left,scope),b=value(node.right,scope);if(a===unknown||b===unknown)return unknown;
      if(node.operator==='..'&&['string','number'].includes(typeof a)&&['string','number'].includes(typeof b))return String(a)+String(b);
      if(node.operator==='==')return a===b;if(node.operator==='~=')return a!==b;
      if(typeof a==='number'&&typeof b==='number'){if(node.operator==='+')return a+b;if(node.operator==='-')return a-b;}
    }
    if(node.type==='UnaryExpression'){const a=value(node.argument,scope);if(a===unknown)return unknown;if(node.operator==='not')return a===false||a===null;if(node.operator==='-'&&typeof a==='number')return -a;}
    if(node.type==='LogicalExpression') {
      const a=value(node.left,scope);if(a===unknown)return unknown;
      return node.operator==='and'?(a===false||a===null?a:value(node.right,scope)):(a===false||a===null?value(node.right,scope):a);
    }
    if(node.type==='CallExpression') {
      const name=nameOf(node.base).split('.').at(-1),args=node.arguments.map(n=>value(n,scope));
      if(name==='GetModConfigData'&&readable(args[0]))return Object.hasOwn(mod.config||{},args[0])?mod.config[args[0]]:unknown;
      if(['resolvefilepath','resolvefilepath_soft','softresolvefilepath'].includes(name))return args[0];
      if(['upper','lower'].includes(name)&&readable(args[0]))return name==='upper'?args[0].toUpperCase():args[0].toLowerCase();
    }
    return unknown;
  }
  function registerTerrain(tile,range,mini) {
    if(!readable(tile)){warning('存在动态地形名称，需要游戏运行数据或适配文件');return;}
    if(range==='NOISE'||range==='IMPASSABLE')return;
    if(!mini||typeof mini!=='object'||!readable(mini.noise_texture)){warning(`地形 ${tile} 的地图材质为动态定义`);return;}
    const name=String(tile).toUpperCase(),custom=readable(mini.name)&&path.basename(mini.name).replace(/\.tex$/,'')!=='map_edge';
    const noise=asset(mini.noise_texture),edge=custom?asset(mini.texture_name||mini.name):null;
    const atlas=custom?asset(mini.atlas||mini.name,'xml'):null;
    result.terrains.push({name,texture:noise,edge,atlas,ocean:range==='OCEAN',mod:String(mod.id)});
    if(!noise)warning(`地形 ${name} 缺少材质 ${mini.noise_texture}`);
  }
  function call(node,scope) {
    const full=nameOf(node.base),name=full.split('.').at(-1),args=node.arguments||[];
    if(name==='AddTile') {
      registerTerrain(value(args[0],scope),value(args[1],scope),value(args[4],scope));
    } else if(name==='AddTileDefs') {
      const defs=value(args[0],scope);
      if(!defs||typeof defs!=='object'){warning('地图地形定义表为动态值');return;}
      for(const [key,def] of Object.entries(defs).slice(0,2048)){
        if(!def||typeof def!=='object'){warning('部分地图地形定义无法读取');continue;}
        const tile=readable(def.tile)?def.tile:(/^\d+$/.test(key)?unknown:key);
        registerTerrain(tile,def.tile_range,def.minimap_tile_def);
      }
    } else if(name==='AddMinimapAtlas') {
      const file=asset(value(args[0],scope),'xml');if(file)result.atlases.push(file);else warning('部分地图图集路径无法解析');
    } else if(name==='SetMiniMapTileProperty') {
      const tile=value(args[0],scope),property=value(args[1],scope),v=value(args[2],scope);
      if(!readable(tile)||!readable(property)||!readable(v)){warning('存在动态地图材质覆盖');return;}
      if(['noise_texture','texture_name','atlas','name'].includes(property)){
        result.overrides.push({name:tile,property,value:v,file:asset(v,property==='atlas'?'xml':'tex'),mod:String(mod.id)});
        if(property==='name')result.overrides.push({name:tile,property:'atlas',value:v,file:asset(v,'xml'),mod:String(mod.id)});
      }
    } else if(['ChangeMiniMapTileRenderOrder','ChangeTileTypeRenderOrder','ChangeTileRenderOrder'].includes(name)) {
      const tile=value(args[0],scope),target=value(args[1],scope),after=value(args[2],scope);
      if(readable(tile)&&readable(target))result.orders.push({name:tile,target,after:after===true});
    } else if(name==='SetIcon'&&/MiniMapEntity/.test(full)) {
      const icon=value(args[0],scope);if(readable(icon)){sourceIcons.add(icon);if(currentFunction)functionIcons.set(currentFunction,icon);}
    } else if(name==='Prefab') {
      const prefab=value(args[0],scope),icon=functionIcons.get(nameOf(args[1]));if(readable(prefab)&&icon)result.aliases[prefab]=icon;
    }
  }
  function visit(node,scope=env,depth=0) {
    mark();if(!node||depth>60)return;
    if(Array.isArray(node)){for(const item of node)visit(item,scope,depth+1);return;}
    if(typeof node!=='object')return;
    if(['LocalStatement','AssignmentStatement'].includes(node.type)) {
      node.variables.forEach((variable,i)=>{if(variable.type==='Identifier')scope.set(variable.name,value(node.init[i],scope));});
    }
    if(node.type==='FunctionDeclaration'){const previous=currentFunction;currentFunction=nameOf(node.identifier);visit(node.body,new Map(scope),depth+1);currentFunction=previous;return;}
    if(node.type==='IfStatement') {
      for(const clause of node.clauses){const test=clause.condition?value(clause.condition,scope):true;if(test===unknown){visit(clause.body,new Map(scope),depth+1);continue;}if(test!==false&&test!==null){visit(clause.body,scope,depth+1);break;}}
      return;
    }
    if(node.type==='ForGenericStatement'&&node.iterators?.length===1) {
      const iterator=node.iterators[0],kind=nameOf(iterator.base),table=iterator.arguments?.length===1?value(iterator.arguments[0],scope):unknown;
      if(['ipairs','pairs'].includes(kind)&&table&&typeof table==='object'){
        const entries=Object.entries(table);if(entries.length>512){warning('地图注册循环超过限制');return;}
        for(const [key,item]of entries){const loop=new Map(scope);node.variables.forEach((v,i)=>loop.set(v.name,i===0?(/^[0-9]+$/.test(key)?Number(key):key):item));visit(node.body,loop,depth+1);}return;
      }
    }
    if(node.type==='CallExpression'){
      const name=nameOf(node.base).split('.').at(-1);
      if(name==='AddPrefabPostInit'&&node.arguments[1]?.type==='FunctionDeclaration'){
        const prefab=value(node.arguments[0],scope),before=sourceIcons;sourceIcons=new Set();visit(node.arguments[1],scope,depth+1);
        if(readable(prefab)&&sourceIcons.size===1)result.aliases[prefab]=[...sourceIcons][0];
        sourceIcons=new Set([...before,...sourceIcons]);return;
      }
      call(node,scope);
    }
    for(const [key,child]of Object.entries(node))if(!['range','loc','comments','variables','init'].includes(key)&&child&&typeof child==='object')visit(child,scope,depth+1);
  }
  let total=0;
  for(const item of files.filter(f=>f.relative.endsWith('.lua'))) {
    if(item.size>2097152||(total+=item.size)>32*1048576){warning('部分地图脚本超过读取限制');continue;}
    const text=fs.readFileSync(item.file,'utf8');
    if(!/AddTile|AddMinimapAtlas|SetMiniMapTileProperty|MiniMapEntity|ChangeMiniMapTileRenderOrder/.test(text))continue;
    sourceFile=item.relative;sourceIcons=new Set();functionIcons=new Map();currentFunction=null;budget=200000;
    try {
      const ast=parseLua(text,2097152,'5.2'),scope=new Map(env);visit(ast.body,scope);
      const prefab=path.basename(sourceFile,'.lua');if(sourceIcons.size===1&&sourceFile.startsWith('scripts/prefabs/')&&!result.aliases[prefab])result.aliases[prefab]=[...sourceIcons][0];
    }catch{warning(`地图脚本 ${sourceFile} 无法静态解析`);}
  }
  return result;
}
function configGame(folder){return path.resolve(folder,'../..');}
