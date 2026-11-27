// One game room, independent of transport. Used by the Node server (server/index.js)
// and by the Cloudflare Durable Object (worker/index.js).
// A socket only needs send(string) and close().
const G = require('./game');

const uuid = () => globalThis.crypto.randomUUID(); // Node 19+ and Workers

class Room {
  // data: saved { game, seats:[{playerId, secret}] } or undefined
  // hooks: { getCustoms: async () => [...], save: async (data) => {} }
  constructor(code, data, hooks = {}) {
    this.code = code;
    this.game = data ? data.game : G.newGameState();
    this.seats = data ? data.seats.map((s) => ({ ...s, socket: null })) : [];
    this.game.players.forEach((p) => { p.connected = false; });
    this.hooks = hooks;
    this.touched = Date.now();
  }

  serialize() { return { game: this.game, seats: this.seats.map(({ playerId, secret }) => ({ playerId, secret })) }; }
  seatOf(sock) { return this.seats.findIndex((s) => s.socket === sock); }
  isEmpty() { return this.seats.length === 0; }
  connectedCount() { return this.seats.filter((s) => s.socket).length; }

  broadcast() {
    this.touched = Date.now();
    this.seats.forEach((s, i) => {
      if (s.socket) try { s.socket.send(JSON.stringify({ t: 'state', code: this.code, host: i === 0, state: G.view(this.game, i) })); } catch {}
    });
  }

  attach(sock, i) {
    const s = this.seats[i];
    if (s.socket && s.socket !== sock) try { s.socket.close(); } catch {}
    s.socket = sock; this.game.players[i].connected = true;
    sock.send(JSON.stringify({ t: 'joined', code: this.code, playerId: s.playerId, secret: s.secret }));
  }

  async message(sock, raw) {
    const send = (m) => { try { sock.send(JSON.stringify(m)); } catch {} };
    let m; try { m = JSON.parse(raw); } catch { return; }
    const g = this.game;
    try {
      const name = String(m.name || '').trim().slice(0, 20) || 'Player';
      const seat = this.seatOf(sock);
      if (m.t === 'create') {
        if (!this.isEmpty()) throw new Error('That room code is taken');
        G.addPlayer(g, 0, name); this.seats.push({ playerId: uuid(), secret: uuid(), socket: null }); this.attach(sock, 0);
      } else if (m.t === 'join') {
        if (this.isEmpty()) throw new Error('No room with that code');
        if (seat >= 0) return;
        G.addPlayer(g, this.seats.length, name); this.seats.push({ playerId: uuid(), secret: uuid(), socket: null }); this.attach(sock, this.seats.length - 1);
      } else if (m.t === 'resume') {
        const i = this.seats.findIndex((s) => s.playerId === m.playerId && s.secret === m.secret);
        if (i < 0) return send({ t: 'resumeFailed' });
        this.attach(sock, i);
      } else {
        if (seat < 0) throw new Error('Join a room first');
        if (m.t === 'start') {
          if (seat !== 0) throw new Error('Only the host can start');
          if (this.hooks.getCustoms) G.setCustomPatterns(await this.hooks.getCustoms());
          G.start(g);
        } else if (m.t === 'options') {
          if (seat !== 0) throw new Error('Only the host can change options');
          if (g.phase !== 'lobby') throw new Error('Game already started');
          if (['original', 'custom', 'both'].includes(m.patternSet)) g.patternSet = m.patternSet;
        } else if (m.t === 'choose') G.choosePattern(g, seat, m.patternId);
        else if (m.t === 'act') G.act(g, seat, m.action || {});
        else if (m.t === 'leave') {
          if (g.phase === 'lobby') { g.players.splice(seat, 1); this.seats.splice(seat, 1); }
          else { this.seats[seat].socket = null; g.players[seat].connected = false; }
          send({ t: 'left' });
        } else return;
      }
      this.broadcast();
      if (this.hooks.save) await this.hooks.save(this.serialize());
    } catch (e) { send({ t: 'error', message: e.message }); }
  }

  close(sock) {
    const i = this.seatOf(sock);
    if (i < 0) return;
    this.seats[i].socket = null; this.game.players[i].connected = false;
    this.broadcast();
  }
}

// Shared custom-pattern API logic (used by Node and the Cloudflare Library object).
function upsertPatterns(list, body) {
  const items = Array.isArray(body) ? body : [body];
  const clean = items.map((p) => ({ ...G.validatePattern(p), id: p.id && String(p.id).startsWith('c-') ? String(p.id) : 'c-' + uuid().slice(0, 8), custom: true }));
  const out = [...list];
  clean.forEach((p) => { const k = out.findIndex((x) => x.id === p.id); if (k >= 0) out[k] = p; else out.push(p); });
  return out;
}

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomCode = () => [...Array(4)].map(() => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
const validCode = (c) => /^[A-Z]{4}$/.test(c);

module.exports = { Room, upsertPatterns, randomCode, validCode };
