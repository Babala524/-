import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { defaultSteamApiKey } from './upstream-default.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const exec = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export class Fault extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function demand(condition, message, status = 400) { if (!condition) throw new Fault(status, message); }
export function identifier(value) { const id = String(value); demand(/^[A-Za-z0-9_-]{1,80}$/.test(id), '标识不合法'); return id; }
export function modID(value) { const id = String(value); demand(/^\d{6,20}$/.test(id), '创意工坊 ID 不合法'); return id; }
export function inside(base, relative = '') {
  const target = path.resolve(base, relative), relativePath = path.relative(path.resolve(base), target);
  demand(!relativePath.startsWith('..') && !path.isAbsolute(relativePath), '路径超出管理目录');
  let current = path.resolve(base);
  demand(!fs.existsSync(current) || !fs.lstatSync(current).isSymbolicLink(), '管理目录不能是符号链接');
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    demand(!fs.existsSync(current) || !fs.lstatSync(current).isSymbolicLink(), '不允许访问符号链接');
  }
  return target;
}
export function atomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, content, { mode }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function jsonRead(file, fallback = null) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
export function sha(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
export function humanSize(size) { return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`; }
export function timeString(ms) { return new Date(ms).toISOString(); }
export function walk(base) {
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    const target = inside(base, entry.name);
    return entry.isDirectory() ? walk(target) : entry.isFile() ? [target] : [];
  });
}
export function tail(file, bytes = 262144) {
  if (!fs.existsSync(file)) return '';
  const safe = inside(path.dirname(file), path.basename(file));
  const fd = fs.openSync(safe, 'r');
  try { const stat = fs.fstatSync(fd), count = Math.min(bytes, stat.size), buffer = Buffer.alloc(count); fs.readSync(fd, buffer, 0, count, stat.size - count); return buffer.toString('utf8'); }
  finally { fs.closeSync(fd); }
}
export function configuration(overrides = {}) {
  const data = path.resolve(process.env.FEATHER_DATA || path.join(root, 'data'));
  return {
    root, data, host: process.env.FEATHER_HOST || '0.0.0.0', port: Number(process.env.FEATHER_PORT || 80),
    python: process.env.FEATHER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    game: path.resolve(process.env.FEATHER_GAME || path.join(data, 'dst')),
    steam: path.resolve(process.env.FEATHER_STEAM || path.join(data, 'steamcmd')),
    publicHost: process.env.FEATHER_PUBLIC_HOST || '',
    adminToken: process.env.FEATHER_ADMIN_TOKEN || '',
    allowRegistration: process.env.FEATHER_ALLOW_REGISTRATION === '1',
    secureCookies: process.env.FEATHER_SECURE_COOKIE === '1',
    clusterToken: process.env.FEATHER_CLUSTER_TOKEN || '',
    steamKey: process.env.FEATHER_STEAM_API_KEY || defaultSteamApiKey(),
    modRegistry: process.env.FEATHER_MOD_REGISTRY ?? 'http://202.189.15.98:35555',
    modRegistryHost: process.env.FEATHER_MOD_REGISTRY_HOST === '1',
    modLibraryLimit: Number(process.env.FEATHER_MOD_LIBRARY_MB || 4096)*1048576,
    translationProvider: process.env.FEATHER_TRANSLATION_PROVIDER || 'mymemory',
    translationURL: process.env.FEATHER_TRANSLATION_URL || '',
    translationKey: process.env.FEATHER_TRANSLATION_KEY || '',
    timezone: process.env.TZ || 'Asia/Shanghai',
    uploadLimit: Number(process.env.FEATHER_UPLOAD_MB || 512) * 1048576,
    extractLimit: Number(process.env.FEATHER_EXTRACT_MB || 2048) * 1048576,
    ...overrides
  };
}
export class Store {
  constructor(config) {
    this.config = config; fs.mkdirSync(config.data, { recursive: true, mode: 0o700 });
    this.clusters = inside(config.data, 'clusters'); fs.mkdirSync(this.clusters, { recursive: true });
    this.db = new DatabaseSync(inside(config.data, 'panel.sqlite'));
    fs.chmodSync(inside(config.data, 'panel.sqlite'),0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, config TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, kind TEXT NOT NULL, room TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, time TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule(room TEXT PRIMARY KEY, day TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_runs(room TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(room,kind));`);
    this.db.prepare("UPDATE tasks SET state='failed', error='面板服务重启，任务中断', updated=? WHERE state IN ('queued','running')").run(timeString(Date.now()));
    const tokenFile = inside(config.data, 'admin-token');
    this.adminToken = config.adminToken || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : crypto.randomBytes(32).toString('base64url'));
    demand(this.adminToken.length >= 24, '管理员密钥至少需要 24 个字符');
    if (!config.adminToken && !fs.existsSync(tokenFile)) atomic(tokenFile, this.adminToken + '\n');
    if (fs.existsSync(tokenFile)) fs.chmodSync(tokenFile,0o600);
    this.locks = new Set();
  }
  cluster(id) { return inside(this.clusters, `Feather_${identifier(id)}`); }
  getRoom(id = '0') { const row = this.db.prepare('SELECT * FROM rooms WHERE id=?').get(identifier(id)); demand(row, '房间尚未创建，请先保存房间配置', 404); return JSON.parse(row.config); }
  rooms() { return this.db.prepare('SELECT id,config,updated FROM rooms').all().map(row => ({ id: row.id, ...JSON.parse(row.config), updated: row.updated })); }
  putRoom(id, data) { this.db.prepare('INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated=excluded.updated').run(identifier(id), JSON.stringify(data), timeString(Date.now())); }
  event(room, message) { this.db.prepare('INSERT INTO events(room,time,message) VALUES(?,?,?)').run(String(room), timeString(Date.now()), message); }
  async locked(room, operation) {
    const id = String(room); demand(!this.restoreBlocked?.has(id),'存档自动回滚未完成，原文件已保留，请先处理恢复错误',409);demand(!this.locks.has(id), '该房间有操作进行中，请稍候', 409); this.locks.add(id);
    try { return await operation(); } finally { if(!this.restoreBlocked?.has(id))this.locks.delete(id); }
  }
  task(kind, room, operation) {
    const id = crypto.randomUUID(), now = timeString(Date.now());
    this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(id, kind, String(room), 'queued', null, null, now, now);
    const report = (progress, message = '', detail = {}) => {
      const value = progress === null ? null : Math.max(0, Math.min(100, Number(progress) || 0));
      this.db.prepare('UPDATE tasks SET result=?,updated=? WHERE id=?').run(JSON.stringify({ ...detail, progress: value, message: String(message).slice(0, 160) }), timeString(Date.now()), id);
    };
    setImmediate(async () => {
      this.db.prepare('UPDATE tasks SET state=?,updated=? WHERE id=?').run('running', timeString(Date.now()), id);
      try {
        report(0, '准备开始');
        const result = await operation(report);
        this.db.prepare('UPDATE tasks SET state=?,result=?,updated=? WHERE id=?').run('succeeded', JSON.stringify(result ?? {}), timeString(Date.now()), id);
        this.event(room, `${kind} 已完成`);
      } catch (error) {
        const cancelled=error.code==='ECANCELED'||/已终止/.test(String(error.message));
        this.db.prepare('UPDATE tasks SET state=?,error=?,updated=? WHERE id=?').run(cancelled?'cancelled':'failed', String(error.message).slice(0, 500), timeString(Date.now()), id);
        this.event(room, `${kind} 失败：${String(error.message).slice(0, 200)}`);
      }
    });
    return { taskID: id };
  }
  getTask(id) { const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(identifier(id)); demand(task, '任务不存在', 404); return { ...task, result: task.result ? JSON.parse(task.result) : null }; }
  close() { this.db.close(); }
}
let cpuSample = cpuTotals();
function cpuTotals(){return os.cpus().reduce((sum,cpu)=>({idle:sum.idle+cpu.times.idle,total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});}
export function systemMetrics() {
  const current=cpuTotals(),elapsed=current.total-cpuSample.total,idle=current.idle-cpuSample.idle;
  const cpuPercent=elapsed>0?Math.max(0,Math.min(100,Math.round((1-idle/elapsed)*100))):null;
  if(elapsed>0)cpuSample=current;
  return { cores:os.cpus().length,memoryTotal:os.totalmem(),memoryUsed:os.totalmem()-os.freemem(),load:os.loadavg(),cpuPercent };
}
