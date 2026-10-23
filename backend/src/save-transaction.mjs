import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, inside, identifier, demand, jsonRead } from './core.mjs';

function syncDirectory(directory){
  if(process.platform!=='linux')return;
  const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}

// The journal bridges the filesystem rename and the SQLite room update. Keep
// replacements beside the live cluster so renames stay on the same filesystem.
export class SaveTransaction {
  constructor(store, record) {
    this.store=store; this.record=record;
    const {id,token}=record; identifier(id);
    demand(/^[a-f0-9-]{36}$/.test(token),'存档恢复事务标识无效');
    this.current=store.cluster(id);
    this.prepared=inside(store.clusters,`.restore-${id}-${token}-new`);
    this.previous=inside(store.clusters,`.restore-${id}-${token}-old`);
    this.displaced=inside(store.clusters,`.restore-${id}-${token}-failed`);
    this.file=inside(store.config.data,`restore-transactions/${id}.json`);
  }
  static create(store,id,room) { return new SaveTransaction(store,{id:identifier(id),token:crypto.randomUUID(),room,phase:'ready'}); }
  static pending(store) {
    const directory=inside(store.config.data,'restore-transactions');
    return fs.existsSync(directory)?fs.readdirSync(directory).filter(name=>name.endsWith('.json')).map(name=>new SaveTransaction(store,jsonRead(inside(directory,name)))):[];
  }
  save() {
    atomic(this.file,JSON.stringify(this.record));
    const fd=fs.openSync(this.file,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    syncDirectory(path.dirname(this.file));
  }
  swap(room) {
    demand(!fs.existsSync(this.file),'存在未完成的存档恢复，请先处理恢复错误',409);
    this.save();
    fs.renameSync(this.current,this.previous);
    fs.renameSync(this.prepared,this.current);
    syncDirectory(this.store.clusters);
    this.store.putRoom(this.record.id,room);
  }
  rollback() {
    this.record.phase='rolling-back';this.save();
    if(fs.existsSync(this.previous)){
      if(fs.existsSync(this.current))fs.renameSync(this.current,this.displaced);
      fs.renameSync(this.previous,this.current);
    }
    syncDirectory(this.store.clusters);
    demand(fs.existsSync(this.current),'原存档暂时无法恢复，已保留恢复文件',500);
    this.store.putRoom(this.record.id,this.record.room);
    this.cleanup();
  }
  commit() {
    const previousPhase=this.record.phase;this.record.phase='committed';
    try{this.save();}catch(error){this.record.phase=previousPhase;throw error;}
  }
  cleanup() {
    for(const directory of [this.prepared,this.previous,this.displaced])fs.rmSync(directory,{recursive:true,force:true});
    fs.rmSync(this.file,{force:true});
  }
}
