// Sathiya server: static files + WebSocket rooms. Run: npm install && npm start
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// ---- Custom patterns (entered by the user), persisted to data/custom-patterns.json ----
const DATA = path.join(__dirname, '..', 'data', 'custom-patterns.json');
let customs = [];
try { customs = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
const saveCustoms = () => { fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(customs, null, 1)); G.setCustomPatterns(customs); };
G.setCustomPatterns(customs);
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
function api(req, res, url) {
  if (url === '/api/patterns' && req.method === 'GET') return json(res, 200, { builtin: G.PATTERNS, custom: customs });
  if (url === '/api/patterns' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const items = Array.isArray(data) ? data : [data];
        const clean = items.map((p) => ({ ...G.validatePattern(p), id: p.id && String(p.id).startsWith('c-') ? String(p.id) : 'c-' + crypto.randomUUID().slice(0, 8), custom: true }));
        clean.forEach((p) => { const k = customs.findIndex((x) => x.id === p.id); if (k >= 0) customs[k] = p; else customs.push(p); });
        saveCustoms(); json(res, 200, { custom: customs });
      } catch (e) { json(res, 400, { error: e.message }); }
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

const rooms = new Map(); // code -> { code, game, seats: [{ playerId, secret, socket }], touched }
const newCode = () => { let c; do { c = [...Array(4)].map(() => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]).join(''); } while (rooms.has(c)); return c; };

function broadcast(room) {
  room.touched = Date.now();
  room.seats.forEach((s, i) => {
    if (s.socket && s.socket.readyState === 1) s.socket.send(JSON.stringify({ t: 'state', code: room.code, host: i === 0, state: G.view(room.game, i) }));
  });
}

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  let room = null, seat = -1;
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const attach = (r, i) => {
    room = r; seat = i; const s = r.seats[i];
    if (s.socket && s.socket !== ws) try { s.socket.close(); } catch {}
    s.socket = ws; r.game.players[i].connected = true;
    send({ t: 'joined', code: r.code, playerId: s.playerId, secret: s.secret });
    broadcast(r);
  };

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      const name = String(m.name || '').trim().slice(0, 20) || 'Player';
      if (m.t === 'create') {
        const r = { code: newCode(), game: G.newGameState(), seats: [], touched: Date.now() };
        rooms.set(r.code, r);
        G.addPlayer(r.game, 0, name);
        r.seats.push({ playerId: crypto.randomUUID(), secret: crypto.randomUUID() });
        return attach(r, 0);
      }
      if (m.t === 'join') {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) throw new Error('No room with that code');
        G.addPlayer(r.game, r.seats.length, name);
        r.seats.push({ playerId: crypto.randomUUID(), secret: crypto.randomUUID() });
        return attach(r, r.seats.length - 1);
      }
      if (m.t === 'resume') {
        const r = rooms.get(String(m.code || '').toUpperCase());
        const i = r ? r.seats.findIndex((s) => s.playerId === m.playerId && s.secret === m.secret) : -1;
        if (i < 0) return send({ t: 'resumeFailed' });
        return attach(r, i);
      }
      if (!room) throw new Error('Join a room first');
      const g = room.game;
      if (m.t === 'start') { if (seat !== 0) throw new Error('Only the host can start'); G.start(g); }
      else if (m.t === 'options') {
        if (seat !== 0) throw new Error('Only the host can change options');
        if (g.phase !== 'lobby') throw new Error('Game already started');
        if (['original', 'custom', 'both'].includes(m.patternSet)) g.patternSet = m.patternSet;
      }
      else if (m.t === 'choose') G.choosePattern(g, seat, m.patternId);
      else if (m.t === 'act') G.act(g, seat, m.action || {});
      else if (m.t === 'leave') {
        if (g.phase === 'lobby') { g.players.splice(seat, 1); room.seats.splice(seat, 1); room.seats.forEach((s, i) => { if (s.socket) s.socket.seat = i; }); }
        send({ t: 'left' }); const r = room; room = null; seat = -1; broadcast(r); rebindSeats(r); return;
      } else return;
      broadcast(room);
    } catch (e) { send({ t: 'error', message: e.message }); }
  });

  // Seats can shift when someone leaves the lobby; keep our index in sync.
  ws.rebind = (r) => { if (room === r) seat = r.seats.findIndex((s) => s.socket === ws); };
  ws.on('close', () => {
    if (!room || seat < 0) return;
    const s = room.seats[seat];
    if (s && s.socket === ws) { s.socket = null; room.game.players[seat].connected = false; broadcast(room); }
  });
});
function rebindSeats(r) { r.seats.forEach((s) => s.socket && s.socket.rebind && s.socket.rebind(r)); }

// Drop rooms idle for 6 hours.
setInterval(() => { const cut = Date.now() - 6 * 3600e3; for (const [c, r] of rooms) if (r.touched < cut) rooms.delete(c); }, 600e3).unref();

server.listen(PORT, () => console.log(`Sathiya running on http://localhost:${PORT}`));
