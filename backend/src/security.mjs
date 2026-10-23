import crypto from 'node:crypto';
import { demand } from './core.mjs';

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length > 512 || right.length > 512) return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Store hashes only. A copied cookie stops working after logout or expiry;
// changing the administrator secret also invalidates every existing session.
export class AdminSessions {
  constructor(store, now = Date.now) {
    this.store = store; this.now = now; this.attempts = new Map();
    store.db.exec('CREATE TABLE IF NOT EXISTS admin_sessions(hash TEXT PRIMARY KEY,created INTEGER NOT NULL,expires INTEGER NOT NULL,user_id INTEGER)');
    try { store.db.exec('ALTER TABLE admin_sessions ADD COLUMN user_id INTEGER'); } catch (error) { if (!/duplicate column/i.test(String(error.message))) throw error; }
    this.cleanup();
  }
  cleanup() { this.store.db.prepare('DELETE FROM admin_sessions WHERE expires<=?').run(this.now()); }
  hash(token) { return crypto.createHmac('sha256', this.store.adminToken).update(token).digest('hex'); }
  cookie(req) {
    const values = (req.headers.cookie || '').split(';').map(value=>value.trim()).filter(value=>value.startsWith('feather_session='));
    return values.length === 1 ? values[0].slice('feather_session='.length) : '';
  }
  revoke(req) {
    const token = this.cookie(req);
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) this.store.db.prepare('DELETE FROM admin_sessions WHERE hash=?').run(this.hash(token));
  }
  authenticated(req) {
    return !!this.principal(req);
  }
  principal(req) {
    const authorization = req.headers.authorization || '';
    if (authorization.startsWith('Bearer ')) return safeEqual(authorization.slice(7), this.store.adminToken) ? { kind: 'token', role: 'admin', userId: null } : null;
    const token = this.cookie(req);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.store.db.prepare('SELECT expires,user_id FROM admin_sessions WHERE hash=?').get(this.hash(token));
    if (!row || row.expires <= this.now()) return null;
    if (row.user_id == null) return { kind: 'session', role: 'admin', userId: null };
    const user = this.store.db.prepare('SELECT id,username,role,disabled FROM users WHERE id=?').get(row.user_id);
    return user && !user.disabled ? { kind: 'account', role: user.role, userId: Number(user.id), username: user.username } : null;
  }
  checkLogin(req) {
    const now = this.now();
    for (const [ip, value] of this.attempts) if (now - value.start >= 60000) this.attempts.delete(ip);
    // Never trust forwarded IP headers supplied by the public client.
    const ip = req.socket.remoteAddress || 'unknown';
    let entry = this.attempts.get(ip);
    demand(entry || this.attempts.size < 10000, '登录繁忙，请稍后重试', 429);
    if (!entry) { entry = {start:now, count:0}; this.attempts.set(ip, entry); }
    demand(++entry.count <= 10, '登录尝试过多，请一分钟后重试', 429);
  }
  issue(req, userId = null) {
    this.cleanup(); this.revoke(req);
    const token = crypto.randomBytes(32).toString('base64url'), now = this.now();
    this.store.db.prepare('INSERT INTO admin_sessions(hash,created,expires,user_id) VALUES(?,?,?,?)').run(this.hash(token), now, now + 12 * 3600000, userId == null ? null : Number(userId));
    this.store.db.prepare('DELETE FROM admin_sessions WHERE hash IN (SELECT hash FROM admin_sessions ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 100)').run();
    return token;
  }
}

export function sessionCookie(token, secure = false) {
  return `feather_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 43200 : 0}${secure ? '; Secure' : ''}`;
}

export function sameOrigin(req, secure = false) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) {
    return !(['POST','PUT','DELETE','PATCH'].includes(req.method) && req.headers['sec-fetch-site'] === 'same-site');
  }
  try {
    const expected = new URL(`${secure || req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`);
    return new URL(req.headers.origin).origin === expected.origin;
  } catch { return false; }
}

export class UploadGate {
  constructor(maximum = 2) { this.maximum = maximum; this.active = 0; }
  reserve() {
    demand(this.active < this.maximum, '同时上传的文件过多，请等待当前上传完成', 429);
    this.active++;
    let released = false;
    return () => { if (!released) { this.active--; released = true; } };
  }
}

export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export function secureHTML(res, html, trustedTemplate) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const markup = trustedTemplate.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const handlers = [...new Set([...markup.matchAll(/\bon[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(match=>match[1] ?? match[2]))];
  const hashes = handlers.map(value=>`'sha256-${crypto.createHash('sha256').update(value).digest('base64')}'`).join(' ');
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; script-src-attr 'unsafe-hashes' ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  res.setHeader('Cache-Control', 'no-store');
  return html.replace(/<script\b([^>]*)>/gi, (_, attributes)=>`<script nonce="${nonce}"${attributes}>`);
}
