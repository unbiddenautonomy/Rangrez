// Rangrez on Cloudflare Workers.
// - Static files in /public are served by Workers Static Assets (see wrangler.jsonc).
// - Each room is a Durable Object (GameRoom) named by its 4-letter code. It holds the live
//   WebSockets, saves the game after every change, and uses an alarm for timed turns.
// - Accounts, login sessions and each player's game list live in one Durable Object
//   (AccountStore) with built-in SQLite storage. No separate database to set up.
// - Custom window patterns live in one Durable Object (PatternLibrary).
import { DurableObject } from 'cloudflare:workers';
import roomLib from '../server/room.js';
import game from '../server/game.js';
import accountLib from '../server/accounts.js';

const { Room, upsertPatterns, randomCode, validCode } = roomLib;
const { Accounts, handleAccountRoute, ACCOUNT_ROUTES } = accountLib;
const KEEP_MS = 30 * 864e5; // rooms are kept for 30 days without activity
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });
const accountStore = (env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts'));
const library = (env) => env.PATTERN_LIBRARY.get(env.PATTERN_LIBRARY.idFromName('library'));

async function whoami(env, request) {
  const r = await accountStore(env).fetch('https://internal/internal/whoami', { headers: { cookie: request.headers.get('cookie') || '' } });
  return (await r.json()).user;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ws = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
    if (ws) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const user = await whoami(env, request);
      if (!user) return new Response('Log in first', { status: 401 });
      const code = ws[1].toUpperCase();
      // The room trusts this header, so it is always set here and never taken from the client.
      const headers = new Headers(request.headers);
      headers.set('x-rangrez-user', JSON.stringify(user));
      return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code)).fetch(new Request(request.url, { headers }));
    }
    if (ACCOUNT_ROUTES.test(url.pathname)) return accountStore(env).fetch(request);
    if (url.pathname === '/api/new-room') return json({ code: randomCode() });
    if (url.pathname.startsWith('/api/patterns')) {
      if (request.method !== 'GET' && !(await whoami(env, request))) return json({ error: 'Log in first' }, 401);
      return library(env).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    // Anything else (e.g. /ABCD room links) falls back to the app via not_found_handling.
    return env.ASSETS.fetch(request);
  },
};

export class AccountStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.accounts = new Accounts({ all: (q, ...p) => sql.exec(q, ...p).toArray(), run: (q, ...p) => { sql.exec(q, ...p); } });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/whoami') {
      const { readCookie } = accountLib;
      return json({ user: await this.accounts.userFromToken(readCookie(request.headers.get('cookie'))) });
    }
    if (url.pathname === '/internal/summary') {
      const { code, ids, summary } = await request.json();
      this.accounts.saveSummary(code, ids, summary);
      return json({ ok: true });
    }
    const r = await handleAccountRoute(this.accounts, {
      method: request.method, path: url.pathname, cookie: request.headers.get('cookie'),
      secure: url.protocol === 'https:', body: () => request.json(),
    });
    return json(r.body, r.status, r.cookie ? { 'Set-Cookie': r.cookie } : {});
  }
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('room');
      this.code = await ctx.storage.get('code');
      if (saved) { this.room = this.makeRoom(this.code, saved); this.room.armClock(); this.room.driveBots(); }
    });
  }

  makeRoom(code, saved) {
    return new Room(code, saved, {
      getCustoms: async () => (await library(this.env).fetch('https://library/api/patterns').then((r) => r.json())).custom,
      save: async (data) => {
        await this.ctx.storage.put({ room: data, lastActive: Date.now() });
        await this.ctx.storage.setAlarm(data.game.deadline || Date.now() + KEEP_MS);
      },
      summary: async (ids, summary) => {
        await accountStore(this.env).fetch('https://internal/internal/summary', { method: 'POST', body: JSON.stringify({ code, ids, summary }) });
      },
      wake: (at) => { this.ctx.storage.setAlarm(at); },
    });
  }

  async fetch(request) {
    const code = new URL(request.url).pathname.split('/').pop().toUpperCase();
    if (!validCode(code)) return new Response('Bad room code', { status: 400 });
    let user = null;
    try { user = JSON.parse(request.headers.get('x-rangrez-user')); } catch {}
    if (!user) return new Response('Log in first', { status: 401 });
    if (!this.room) { this.code = code; await this.ctx.storage.put('code', code); this.room = this.makeRoom(code, null); }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const sock = { user, send: (s) => server.send(s), close: () => server.close() };
    server.addEventListener('message', (e) => this.room.message(sock, typeof e.data === 'string' ? e.data : ''));
    const gone = () => this.room && this.room.close(sock);
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Fires for a timed turn running out, or for the 30-day cleanup.
  async alarm() {
    if (!this.room) return this.ctx.storage.deleteAll();
    const g = this.room.game;
    if (g.phase === 'playing' && g.deadline) {
      if (Date.now() >= g.deadline) await this.room.checkClock();
      else await this.ctx.storage.setAlarm(g.deadline);
      return;
    }
    const last = (await this.ctx.storage.get('lastActive')) || 0;
    if (this.room.connectedCount() === 0 && last < Date.now() - KEEP_MS) { await this.ctx.storage.deleteAll(); this.room = null; }
    else await this.ctx.storage.setAlarm(last + KEEP_MS);
  }
}

export class PatternLibrary extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const list = (await this.ctx.storage.get('custom')) || [];
    if (url.pathname === '/api/patterns' && request.method === 'GET') return json({ builtin: game.PATTERNS, custom: list });
    if (url.pathname === '/api/patterns' && request.method === 'POST') {
      try {
        const next = upsertPatterns(list, await request.json());
        await this.ctx.storage.put('custom', next);
        return json({ custom: next });
      } catch (e) { return json({ error: e.message }, 400); }
    }
    const m = url.pathname.match(/^\/api\/patterns\/(c-[\w-]+)$/);
    if (m && request.method === 'DELETE') {
      const next = list.filter((p) => p.id !== m[1]);
      await this.ctx.storage.put('custom', next);
      return json({ custom: next });
    }
    return json({ error: 'Not found' }, 404);
  }
}
