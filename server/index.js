// Rangrez Node server: static files + WebSocket rooms. Run: npm install && npm start
// (The Cloudflare version lives in worker/index.js and shares server/room.js + server/game.js.)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const G = require('./game');
const { Room, upsertPatterns, randomCode, validCode } = require('./room');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// ---- Custom patterns (entered by the user), persisted to data/custom-patterns.json ----
const DATA = path.join(__dirname, '..', 'data', 'custom-patterns.json');
let customs = [];
try { customs = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
const saveCustoms = () => { fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(customs, null, 1)); };

const rooms = new Map(); // code -> Room
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

function api(req, res, url) {
  if (url === '/api/new-room') { let c; do { c = randomCode(); } while (rooms.has(c)); return json(res, 200, { code: c }); }
  if (url === '/api/patterns' && req.method === 'GET') return json(res, 200, { builtin: G.PATTERNS, custom: customs });
  if (url === '/api/patterns' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { customs = upsertPatterns(customs, JSON.parse(body)); saveCustoms(); json(res, 200, { custom: customs }); }
      catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }
  const m = url.match(/^\/api\/patterns\/(c-[\w-]+)$/);
  if (m && req.method === 'DELETE') { customs = customs.filter((p) => p.id !== m[1]); saveCustoms(); return json(res, 200, { custom: customs }); }
  json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res, req.url.split('?')[0]);
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

// WebSocket endpoint: /ws/<ROOMCODE>
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const m = req.url.match(/^\/ws\/([A-Za-z]{4})/);
  const code = m && m[1].toUpperCase();
  if (!code || !validCode(code)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    let room = rooms.get(code);
    if (!room) { room = new Room(code, null, { getCustoms: async () => customs }); rooms.set(code, room); }
    ws.on('message', (raw) => room.message(ws, String(raw)));
    ws.on('close', () => room.close(ws));
  });
});

// Drop rooms that are empty or idle for 6 hours.
setInterval(() => {
  const cut = Date.now() - 6 * 3600e3;
  for (const [c, r] of rooms) if ((r.isEmpty() && r.touched < Date.now() - 60e3) || r.touched < cut) rooms.delete(c);
}, 60e3).unref();

server.listen(PORT, () => console.log(`Rangrez running on http://localhost:${PORT}`));
