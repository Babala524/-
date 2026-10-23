import { demand } from './core.mjs';
import { lua } from './lua.mjs';

export function normaliseAnnouncements(input) {
  const value=input??{enabled:false,message:'',intervalMinutes:30};
  demand(value&&typeof value==='object'&&!Array.isArray(value),'游戏内公告设置不合法');
  const {enabled=false,message='',intervalMinutes=30}=value;
  demand(typeof enabled==='boolean'&&typeof message==='string'&&message.length<=500&&!/[\x00-\x08\x0b-\x1f\x7f]/.test(message),'游戏内公告最多 500 个字符，不能包含控制字符');
  demand(Number.isInteger(intervalMinutes)&&intervalMinutes>=1&&intervalMinutes<=1440,'公告间隔应为 1～1440 分钟');
  demand(!enabled||message.trim(),'启用游戏内公告前请填写公告内容');
  return {enabled,message,intervalMinutes};
}

export class Announcements {
  constructor(store,runtime){
    this.store=store;this.runtime=runtime;this.pending=false;this.retryAt=new Map();
    store.db.exec('CREATE TABLE IF NOT EXISTS announcement_runs(room TEXT PRIMARY KEY, signature TEXT NOT NULL, sent INTEGER NOT NULL)');
  }
  async send(id,at=Date.now()) {
    return this.store.locked(id,async()=>{
      demand(!this.store.sharedBusy,'游戏文件正在更新，请稍后发送公告',409);
      const room=this.store.getRoom(id),value=normaliseAnnouncements(room.announcement);
      demand(value.message.trim(),'请先填写并保存游戏内公告',409);
      // The master broadcasts to the entire cluster; sending to every shard duplicates messages.
      const master=(await this.runtime.status(id)).find(world=>world.directory===room.worlds[0].directory);
      demand(master?.running,'主世界未运行，无法发送游戏内公告',409);
      await this.runtime.command(id,`c_announce(${lua(value.message)})`,[master.directory]);
      const signature=JSON.stringify(value);
      this.store.db.prepare('INSERT INTO announcement_runs VALUES(?,?,?) ON CONFLICT(room) DO UPDATE SET signature=excluded.signature,sent=excluded.sent').run(String(id),signature,at);
      this.store.event(id,'游戏内公告发送命令已提交');
      return {submitted:true};
    });
  }
  async tick(at=Date.now()) {
    if(this.pending||this.store.sharedBusy)return;
    this.pending=true;
    try{for(const room of this.store.rooms()){
      if(this.store.locks.has(room.id)||(this.retryAt.get(room.id)||0)>at)continue;
      try{
        const value=normaliseAnnouncements(room.announcement);
        if(!value.enabled){this.store.db.prepare('DELETE FROM announcement_runs WHERE room=?').run(room.id);continue;}
        const master=(await this.runtime.status(room.id)).find(world=>world.directory===room.worlds[0].directory);
        if(!master?.running){this.store.db.prepare('DELETE FROM announcement_runs WHERE room=?').run(room.id);continue;}
        const signature=JSON.stringify(value),previous=this.store.db.prepare('SELECT signature,sent FROM announcement_runs WHERE room=?').get(room.id);
        if(!previous||previous.signature!==signature||at<previous.sent){this.store.db.prepare('INSERT INTO announcement_runs VALUES(?,?,?) ON CONFLICT(room) DO UPDATE SET signature=excluded.signature,sent=excluded.sent').run(room.id,signature,at);continue;}
        if(at-previous.sent<value.intervalMinutes*60000)continue;
        await this.send(room.id,at);this.retryAt.delete(room.id);
      }catch(error){this.retryAt.set(room.id,at+60000);this.store.event(room.id,'定时公告发送失败：'+String(error.message).slice(0,160));}
    }}finally{this.pending=false;}
  }
}
