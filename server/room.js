// One game room, independent of transport. Used by the Node server (server/index.js)
// and by the Cloudflare Durable Object (worker/index.js).
// A socket only needs send(string) and close().
const G = require('./game');
const Bots = require('./bots');
const BOT_DELAY = +(globalThis.process && process.env && process.env.BOT_DELAY) || 900; // ms a bot 'thinks' before moving, so humans can follow along

const uuid = () => globalThis.crypto.randomUUID(); // Node 19+ and Workers

class Room {
  // data: saved { game, seats:[{playerId, secret}] } or undefined
  // hooks: { getCustoms: async () => [...], save: async (data) => {} }
  constructor(code, data, hooks = {}) {
    this.code = code;
    this.game = data ? data.game : G.newGameState();
    this.seats = data ? data.seats.map((s) => ({ ...s, socket: null })) : [];
    this.game.players.forEach((p) => { p.connected = !!p.bot; });
    this.botTimer = null;
    this.hooks = hooks;
    this.touched = Date.now();
  }

  serialize() { return { game: this.game, seats: this.seats.map(({ playerId, secret, bot }) => ({ playerId, secret, bot })) }; }
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
        } else if (m.t === 'addBot') {
          if (seat !== 0) throw new Error('Only the host can add bots');
          const level = ['easy', 'medium', 'hard'].includes(m.level) ? m.level : 'medium';
          G.addPlayer(g, this.seats.length, Bots.botName(g.players.map((p) => p.name), level));
          const bp = g.players[g.players.length - 1]; bp.bot = level; bp.connected = true;
          this.seats.push({ playerId: uuid(), secret: uuid(), bot: level, socket: null });
        } else if (m.t === 'removeBot') {
          if (seat !== 0) throw new Error('Only the host can remove bots');
          if (g.phase !== 'lobby') throw new Error('Game already started');
          const i = +m.seat;
          if (!this.seats[i] || !this.seats[i].bot) throw new Error('That is not a bot');
          g.players.splice(i, 1); this.seats.splice(i, 1);
        } else if (m.t === 'options') {
          if (seat !== 0) throw new Error('Only the host can change options');
          if (g.phase !== 'lobby') throw new Error('Game already started');
          if (['original', 'custom', 'both'].includes(m.patternSet)) g.patternSet = m.patternSet;
        } else if (m.t === 'choose') G.choosePattern(g, seat, m.patternId);
        else if (m.t === 'act') G.act(g, seat, m.action || {});
        else if (m.t === 'leave') {
          if (g.phase === 'lobby') {
            g.players.splice(seat, 1); this.seats.splice(seat, 1);
            // Keep a human as host (seat 0); with no humans left, the room is emptied.
            const h = this.seats.findIndex((x) => !x.bot);
            if (h < 0) { g.players.length = 0; this.seats.length = 0; }
            else if (h > 0) { this.seats.unshift(...this.seats.splice(h, 1)); g.players.unshift(...g.players.splice(h, 1)); }
          }
          else { this.seats[seat].socket = null; g.players[seat].connected = false; }
          send({ t: 'left' });
        } else return;
      }
      await this.changed();
    } catch (e) { send({ t: 'error', message: e.message }); }
  }

  async changed() {
    this.broadcast();
    if (this.hooks.save) await this.hooks.save(this.serialize());
    this.driveBots();
  }

  // Let bots pick patterns and take their turns, one turn at a time with a short delay.
  driveBots() {
    const g = this.game;
    if (this.botTimer) return;
    if (g.phase === 'choosing') {
      const waiting = g.players.map((p, i) => [p, i]).filter(([p]) => p.bot && p.pattern === null);
      if (!waiting.length) return;
      this.botTimer = setTimeout(async () => {
        this.botTimer = null;
        for (const [p, i] of waiting) if (g.phase === 'choosing' && p.pattern === null) G.choosePattern(g, i, Bots.choosePattern(g, i, p.bot));
        await this.changed();
      }, 400);
      return;
    }
    if (g.phase !== 'playing') return;
    const pi = g.order[g.turn], p = g.players[pi];
    if (!p || !p.bot) return;
    this.botTimer = setTimeout(async () => {
      this.botTimer = null;
      if (g.phase !== 'playing' || g.order[g.turn] !== pi) return;
      try {
        for (const a of Bots.planTurn(g, pi, p.bot)) {
          if (a.type === 'placeBest') {
            const pat = g.patterns[p.pattern];
            const b = Bots.bestPlacement(g, p, pat, g.lock ? g.pool.filter((d) => d.id === g.lock) : g.pool, p.bot);
            if (b) G.act(g, pi, { type: 'place', dieId: b.d.id, cell: b.i });
          } else G.act(g, pi, a);
        }
      } catch (e) { /* a bot move failed validation: just end its turn */ }
      try { G.act(g, pi, { type: 'pass' }); } catch {}
      await this.changed();
    }, BOT_DELAY);
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
