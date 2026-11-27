// Rangrez Node server: static files, accounts, and WebSocket rooms. Run: npm install && npm start
// Everything is saved in data/rangrez.db (SQLite), so games survive restarts and can last for days.
// (The Cloudflare version lives in worker/index.js and shares the files in server/.)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');
const G = require('./game');
const { Room, upsertPatterns, randomCode, validCode } = require('./room');
const { Accounts, handleAccountRoute, readCookie, ACCOUNT_ROUTES } = require('./accounts');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const KEEP_MS = 30 * 864e5; // rooms are kept for 30 days without activity

fs.mkdirSync(DATA_DIR, { recursive: true });
const sqlite = new DatabaseSync(path.join(DATA_DIR, 'rangrez.db'));
const db = { all: (q, ...p) => sqlite.prepare(q).all(...p), run: (q, ...p) => { sqlite.prepare(q).run(...p); } };
const accounts = new Accounts(db);
db.run('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)');
db.run('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');

// ---- Custom patterns (entered by players) ----
const getCustoms = () => { const r = db.all("SELECT v FROM kv WHERE k = 'custom'")[0]; return r ? JSON.parse(r.v) : []; };
const setCustoms = (list) => db.run("INSERT INTO kv (k, v) VALUES ('custom', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(list));

// ---- Rooms: live in memory while in use, saved to SQLite after every change ----
const rooms = new Map();
function getRoom(code) {
  let room = rooms.get(code);
  if (room) return room;
  const row = db.all('SELECT data, updated FROM rooms WHERE code = ?', code)[0];
  const saved = row && row.updated > Date.now() - KEEP_MS ? JSON.parse(row.data) : null;
  room = new Room(code, saved, {
    getCustoms: async () => getCustoms(),
    save: async (data) => db.run('INSERT INTO rooms (code, data, updated) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated = excluded.updated', code, JSON.stringify(data), Date.now()),
    summary: async (ids, s) => accounts.saveSummary(code, ids, s),
  });
  rooms.set(code, room);
  room.armClock(); // a timed game may have a turn running
  room.driveBots();
  return room;
}
const roomExists = (code) => rooms.has(code) || db.all('SELECT 1 FROM rooms WHERE code = ?', code).length > 0;

const json = (res, code, body, cookie) => { res.writeHead(code, { 'Content-Type': 'application/json', ...(cookie ? { 'Set-Cookie': cookie } : {}) }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
});

async function api(req, res, url) {
  if (ACCOUNT_ROUTES.test(url)) {
    const r = await handleAccountRoute(accounts, { method: req.method, path: url, cookie: req.headers.cookie, secure: false, body: () => readBody(req) });
    return json(res, r.status, r.body, r.cookie);
  }
  if (url === '/api/new-room') { let c; do { c = randomCode(); } while (roomExists(c)); return json(res, 200, { code: c }); }
  if (url === '/api/patterns' && req.method === 'GET') return json(res, 200, { builtin: G.PATTERNS, custom: getCustoms() });
  const user = await accounts.userFromToken(readCookie(req.headers.cookie));
  if (!user) return json(res, 401, { error: 'Log in first' });
  if (url === '/api/patterns' && req.method === 'POST') {
    try { const list = upsertPatterns(getCustoms(), await readBody(req)); setCustoms(list); return json(res, 200, { custom: list }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  const m = url.match(/^\/api\/patterns\/(c-[\w-]+)$/);
  if (m && req.method === 'DELETE') { const list = getCustoms().filter((p) => p.id !== m[1]); setCustoms(list); return json(res, 200, { custom: list }); }
  json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res, req.url.split('?')[0]).catch((e) => json(res, 500, { error: e.message }));
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(PUBLIC, url === '/' ? 'index.html' : url);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { // unknown paths fall back to the app so /ROOM links work
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => { res.writeHead(e2 ? 404 : 200, { 'Content-Type': 'text/html' }); res.end(d2); });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// WebSocket endpoint: /ws/<ROOMCODE>, only for logged-in players.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, socket, head) => {
  const m = req.url.match(/^\/ws\/([A-Za-z]{4})/);
  const code = m && m[1].toUpperCase();
  const user = await accounts.userFromToken(readCookie(req.headers.cookie)).catch(() => null);
  if (!code || !validCode(code) || !user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    const room = getRoom(code);
    ws.on('message', (raw) => room.message(ws, String(raw)));
    ws.on('close', () => room.close(ws));
  });
});

// Unload idle rooms from memory (they stay saved) and delete rooms idle for 30 days.
setInterval(() => {
  for (const [c, r] of rooms) {
    const ticking = r.game.mode === 'timed' && r.game.phase === 'playing';
    if (r.connectedCount() === 0 && r.touched < Date.now() - 10 * 60e3 && !ticking) { clearTimeout(r.clock); rooms.delete(c); }
  }
  db.run('DELETE FROM rooms WHERE updated < ?', Date.now() - KEEP_MS);
}, 60e3).unref();

server.listen(PORT, () => console.log(`Rangrez running on http://localhost:${PORT}`));
