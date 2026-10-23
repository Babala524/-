// Online time is sampled independently of browser visits. Only adjacent,
// complete observations in this process contribute time; outages never do.
export class PlayerStats {
  constructor(db) {
    this.db=db; this.previous=new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS player_statistics(room TEXT NOT NULL, userid TEXT NOT NULL, name TEXT NOT NULL, prefab TEXT NOT NULL, world TEXT NOT NULL, player_days INTEGER, seconds REAL NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY(room,userid));
      CREATE TABLE IF NOT EXISTS player_statistics_start(room TEXT PRIMARY KEY, started INTEGER NOT NULL);`);
  }
  observe(room,state,now=Date.now()) {
    room=String(room);
    if(state.telemetry?.complete!==true){this.previous.delete(room);return;}
    const players=new Map();
    for(const player of state.playerList||[])if(/^KU_[A-Za-z0-9_-]{4,80}$/.test(player.userid||'')){
      const previous=players.get(player.userid);
      if(!previous||player.localPlayer||!previous.localPlayer)players.set(player.userid,player);
    }
    const previous=this.previous.get(room),elapsed=previous?(now-previous.time)/1000:0;
    const continuous=elapsed>0&&elapsed<=45;
    const insert=this.db.prepare(`INSERT INTO player_statistics VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(room,userid) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE name END,prefab=CASE WHEN excluded.prefab<>'' THEN excluded.prefab ELSE prefab END,world=excluded.world,player_days=COALESCE(excluded.player_days,player_days),seconds=seconds+excluded.seconds,last_seen=excluded.last_seen`);
    this.db.exec('BEGIN');
    try{
      this.db.prepare('INSERT OR IGNORE INTO player_statistics_start VALUES(?,?)').run(room,now);
      for(const [id,p] of players)insert.run(room,id,String(p.name||'').slice(0,160),String(p.prefab||'').slice(0,100),String(p.world||'').slice(0,100),Number.isFinite(p.playerage)?p.playerage:null,continuous&&previous.ids.has(id)?elapsed:0,now,now);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.previous.set(room,{time:now,ids:new Set(players.keys())});
  }
  ranking(room) {
    return this.db.prepare('SELECT * FROM player_statistics WHERE room=? ORDER BY seconds DESC,first_seen ASC,userid ASC').all(String(room)).map(p=>({userid:p.userid,name:p.name||'未命名玩家',prefab:p.prefab,world:p.world,playerDays:p.player_days,playSeconds:Math.floor(p.seconds),firstSeen:new Date(p.first_seen).toISOString(),lastSeen:new Date(p.last_seen).toISOString()}));
  }
  started(room){const value=this.db.prepare('SELECT started FROM player_statistics_start WHERE room=?').get(String(room));return value?new Date(value.started).toISOString():null;}
}
