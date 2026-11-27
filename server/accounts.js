// Player accounts, login sessions and each player's list of games.
// Storage is plain SQLite through a tiny adapter, so the same code runs on
//   - Node:        node:sqlite (data/rangrez.db)
//   - Cloudflare:  the SQLite storage of the Accounts Durable Object
// adapter: { all(sql, ...params) -> rows[], run(sql, ...params) }

const SESSION_DAYS = 60;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => hex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(s)));

async function hashPassword(password, saltHex) {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  // 100k iterations is the most Cloudflare Workers allows for PBKDF2.
  return hex(await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
function sameHex(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

class Accounts {
  constructor(db) {
    this.db = db;
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS games (user_id INTEGER NOT NULL, code TEXT NOT NULL, summary TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, code))`);
  }

  async register(name, password) {
    name = String(name || '').trim();
    password = String(password || '');
    if (!/^[\p{L}\p{N} _.-]{2,20}$/u.test(name)) throw new Error('Pick a name of 2 to 20 letters or numbers');
    if (password.length < 6) throw new Error('Password must be at least 6 characters');
    if (this.db.all('SELECT id FROM users WHERE name = ?', name).length) throw new Error('That name is taken');
    const salt = randomHex(16);
    this.db.run('INSERT INTO users (name, salt, hash, created) VALUES (?, ?, ?, ?)', name, salt, await hashPassword(password, salt), Date.now());
    return this.login(name, password);
  }

  async login(name, password) {
    const u = this.db.all('SELECT id, name, salt, hash FROM users WHERE name = ?', String(name || '').trim())[0];
    if (!u || !sameHex(await hashPassword(String(password || ''), u.salt), u.hash)) throw new Error('Wrong name or password');
    const token = randomHex(32);
    this.db.run('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)', await sha256(token), u.id, Date.now() + SESSION_DAYS * 864e5);
    this.db.run('DELETE FROM sessions WHERE expires < ?', Date.now());
    return { user: { id: u.id, name: u.name }, token };
  }

  async logout(token) { if (token) this.db.run('DELETE FROM sessions WHERE token_hash = ?', await sha256(token)); }

  async userFromToken(token) {
    if (!token) return null;
    const r = this.db.all('SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?', await sha256(token), Date.now())[0];
    return r ? { id: r.id, name: r.name } : null;
  }

  // Called by a room after every change, for each human player in it.
  saveSummary(code, userIds, summary) {
    const now = Date.now(), json = JSON.stringify(summary);
    for (const id of userIds) {
      this.db.run('INSERT INTO games (user_id, code, summary, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, code) DO UPDATE SET summary = excluded.summary, updated = excluded.updated', id, code, json, now);
    }
  }

  forgetGame(userId, code) { this.db.run('DELETE FROM games WHERE user_id = ? AND code = ?', userId, code); }

  listGames(userId) {
    const cutoff = Date.now() - 30 * 864e5; // rooms are kept for 30 days without activity
    return this.db.all('SELECT code, summary, updated FROM games WHERE user_id = ? AND updated > ? ORDER BY updated DESC LIMIT 50', userId, cutoff)
      .map((r) => ({ code: r.code, updated: r.updated, ...JSON.parse(r.summary) }));
  }
}

// Cookie helpers shared by both servers.
const COOKIE = 'rangrez_session';
function readCookie(header) {
  const m = String(header || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
  return m ? m[1] : null;
}
function sessionCookie(token, secure) {
  const base = `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return token ? `${base}; Max-Age=${SESSION_DAYS * 86400}` : `${base}; Max-Age=0`;
}

// One HTTP-ish handler for the account routes, used by Node and the Worker.
// req: { method, path, cookie, secure, body: async () => object }
// returns { status, body, cookie? }
async function handleAccountRoute(accounts, req) {
  try {
    if (req.path === '/api/register' && req.method === 'POST') {
      const b = await req.body(); const r = await accounts.register(b.name, b.password);
      return { status: 200, body: { user: r.user }, cookie: sessionCookie(r.token, req.secure) };
    }
    if (req.path === '/api/login' && req.method === 'POST') {
      const b = await req.body(); const r = await accounts.login(b.name, b.password);
      return { status: 200, body: { user: r.user }, cookie: sessionCookie(r.token, req.secure) };
    }
    if (req.path === '/api/logout' && req.method === 'POST') {
      await accounts.logout(readCookie(req.cookie));
      return { status: 200, body: { ok: true }, cookie: sessionCookie(null, req.secure) };
    }
    const user = await accounts.userFromToken(readCookie(req.cookie));
    if (req.path === '/api/me' && req.method === 'GET') {
      if (!user) return { status: 401, body: { user: null } };
      return { status: 200, body: { user, games: accounts.listGames(user.id) } };
    }
    const fm = req.path.match(/^\/api\/games\/([A-Z]{4})$/);
    if (fm && req.method === 'DELETE') {
      if (!user) return { status: 401, body: { error: 'Log in first' } };
      accounts.forgetGame(user.id, fm[1]);
      return { status: 200, body: { games: accounts.listGames(user.id) } };
    }
    return { status: 404, body: { error: 'Not found' } };
  } catch (e) { return { status: 400, body: { error: e.message } }; }
}

const ACCOUNT_ROUTES = /^\/api\/(register|login|logout|me|games\/[A-Z]{4})$/;

module.exports = { Accounts, handleAccountRoute, readCookie, ACCOUNT_ROUTES };
