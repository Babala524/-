import fs from 'node:fs';
import {demand,inside,jsonRead} from './core.mjs';

const interval=15*60000;
export class ModUpdates {
  constructor(store,mods){
    this.store=store;this.mods=mods;this.busy=false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS mod_update_settings(id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL,last_check INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
      INSERT OR IGNORE INTO mod_update_settings(id,enabled) VALUES(1,1);
      CREATE TABLE IF NOT EXISTS mod_update_jobs(mod TEXT PRIMARY KEY,version INTEGER NOT NULL,task TEXT NOT NULL,attempts INTEGER NOT NULL,retry_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,dedupe TEXT UNIQUE NOT NULL,created TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,payload TEXT NOT NULL,is_read INTEGER NOT NULL DEFAULT 0);`);
    mods.onUpdated=entry=>this.completed(entry);
  }
  notify(key,kind,title,payload){
    this.store.db.prepare('INSERT OR IGNORE INTO inbox(dedupe,created,kind,title,payload) VALUES(?,?,?,?,?)').run(key,new Date().toISOString(),kind,title,JSON.stringify(payload));
  }
  completed({taskID,id,name,result,automatic}){
    this.notify('mod-task:'+taskID,'mod-updated','模组更新已完成',{modID:id,name,automatic:automatic===true,deferred:result.deferred===true,message:result.deferred?'新版文件已下载并暂存，请自行重启游戏后应用。共享多个房间时，需先关闭所有房间再启动。':'新版文件已安装，当前关闭的房间下次启动时加载。'});
  }
  status(){const settings=this.store.db.prepare('SELECT * FROM mod_update_settings WHERE id=1').get();return {enabled:Boolean(settings.enabled),intervalMinutes:15,lastCheck:settings.last_check?new Date(settings.last_check).toISOString():null,nextCheck:settings.enabled?new Date(Math.max(Date.now(),settings.last_check+interval)).toISOString():null,error:settings.error,checking:this.busy,active:this.mods.jobs.size};}
  list(){return {...this.status(),unread:this.store.db.prepare('SELECT count(*) AS n FROM inbox WHERE is_read=0').get().n,rows:this.store.db.prepare('SELECT id,created,kind,title,payload,is_read FROM inbox ORDER BY id DESC LIMIT 100').all().map(row=>({...row,read:Boolean(row.is_read),payload:JSON.parse(row.payload)}))};}
  configure(enabled){demand(typeof enabled==='boolean','自动更新开关必须为布尔值');this.store.db.prepare('UPDATE mod_update_settings SET enabled=? WHERE id=1').run(enabled?1:0);return this.status();}
  markRead(through){demand(Number.isSafeInteger(through)&&through>=0,'通知序号不合法');this.store.db.prepare('UPDATE inbox SET is_read=1 WHERE id<=?').run(through);return this.list();}
  reconcile(at){
    for(const job of this.store.db.prepare('SELECT * FROM mod_update_jobs').all()){
      const task=this.store.getTask(job.task);
      if(task.state==='succeeded'){
        this.completed({taskID:job.task,id:job.mod,name:jsonRead(this.mods.metadata(job.mod),{}).name||'Workshop '+job.mod,result:task.result||{},automatic:true});
      }else if(task.state==='failed'&&!job.retry_at){
        this.store.db.prepare('UPDATE mod_update_jobs SET retry_at=? WHERE mod=?').run(at+Math.min(60,5*2**(job.attempts-1))*60000,job.mod);
        this.notify('mod-failed:'+job.task,'mod-update-failed','模组自动更新失败',{modID:job.mod,name:jsonRead(this.mods.metadata(job.mod),{}).name||'Workshop '+job.mod,message:String(task.error||'下载失败').slice(0,300)+'；现有游戏文件保留。'+(job.attempts<3?'稍后自动重试。':'本版本自动重试已达 3 次，请在模组管理中手动重试。')});
      }
    }
  }
  async tick(at=Date.now(),force=false){
    if(this.busy)return {checking:true};
    this.reconcile(at);
    const settings=this.status();
    if(!settings.enabled&&!force||!force&&settings.lastCheck&&at-Date.parse(settings.lastCheck)<interval||this.store.sharedBusy||this.store.locks.size||this.mods.jobs.size)return {skipped:true};
    const rooms=this.store.rooms();if(!rooms.length)return {skipped:true};
    this.busy=true;let queued=0,unknown=0;
    try{
      const ids=this.mods.installedIDs().filter(id=>jsonRead(this.mods.receipt(id),{})?.source!=='local-library');let warning='';
      for(let offset=0;offset<ids.length;offset+=100){
        const result=await this.mods.details(ids.slice(offset,offset+100));
        if(result.warning||result.source==='cache'){warning=result.warning||'工坊暂不可用，等待下次检查';continue;}
        for(const info of result.rows){
          if(!this.mods.find(info.id)||this.mods.jobs.has(info.id)||this.store.sharedBusy)continue;
          const latest=Number(info.version),local=this.mods.localRevision(info.id,this.mods.find(info.id));
          if(!local?.timeUpdated){unknown++;continue;}
          const pending=jsonRead(inside(this.mods.pending(info.id),'revision.json'),{}),hasPending=fs.existsSync(inside(this.mods.pending(info.id),'files/modinfo.lua'));
          if(!Number.isSafeInteger(latest)||latest<=Math.max(local.timeUpdated,hasPending?pending.timeUpdated||0:0))continue;
          const old=this.store.db.prepare('SELECT * FROM mod_update_jobs WHERE mod=?').get(info.id);
          let attempts=1;
          if(old?.version===latest){
            const task=this.store.getTask(old.task);
            if(['queued','running'].includes(task.state))continue;
            if(task.state==='succeeded')continue;
            if(task.state==='failed'&&(old.attempts>=3||at<old.retry_at))continue;
            attempts=old.attempts+1;
          }
          const room=rooms.find(room=>room.mods.some(mod=>mod.id===info.id&&mod.enabled))||rooms[0];
          const task=this.mods.enqueue(room.id,info.id,{automatic:true,stageOnly:true});
          this.store.db.prepare('INSERT INTO mod_update_jobs VALUES(?,?,?,?,?) ON CONFLICT(mod) DO UPDATE SET version=excluded.version,task=excluded.task,attempts=excluded.attempts,retry_at=excluded.retry_at').run(info.id,latest,task.taskID,attempts,0);queued++;
        }
      }
      this.store.db.prepare('UPDATE mod_update_settings SET last_check=?,error=? WHERE id=1').run(at,warning||(unknown?`${unknown} 个模组缺少本地版本凭据，请手动更新一次以建立版本记录。`:''));
      return {checked:ids.length,queued,unknown};
    }catch(error){this.store.db.prepare('UPDATE mod_update_settings SET last_check=?,error=? WHERE id=1').run(at,String(error.message).slice(0,300));return {error:String(error.message)};}
    finally{this.busy=false;}
  }
}
