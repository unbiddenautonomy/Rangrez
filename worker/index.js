// Kaanch Mahal on Cloudflare Workers.
// - Static files in /public are served by Workers Static Assets (see wrangler.jsonc).
// - Each room is a Durable Object (GameRoom) named by its 4-letter code; it holds the
//   live WebSockets and saves the game to its storage after every change.
// - Custom window patterns live in one Durable Object (PatternLibrary).
import { DurableObject } from 'cloudflare:workers';
import roomLib from '../server/room.js';
import game from '../server/game.js';

const { Room, upsertPatterns, randomCode, validCode } = roomLib;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const library = (env) => env.PATTERN_LIBRARY.get(env.PATTERN_LIBRARY.idFromName('library'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ws = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
    if (ws) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const code = ws[1].toUpperCase();
      return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code)).fetch(request);
    }
    if (url.pathname === '/api/new-room') return json({ code: randomCode() });
    if (url.pathname.startsWith('/api/patterns')) return library(env).fetch(request);
    // Anything else (e.g. /ABCD room links) falls back to the app via not_found_handling.
    return env.ASSETS.fetch(request);
  },
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('room');
      this.code = await ctx.storage.get('code');
      if (saved) this.room = this.makeRoom(this.code, saved);
    });
  }

  makeRoom(code, saved) {
    return new Room(code, saved, {
      getCustoms: async () => (await library(this.env).fetch('https://library/api/patterns').then((r) => r.json())).custom,
      save: async (data) => {
        await this.ctx.storage.put('room', data);
        await this.ctx.storage.setAlarm(Date.now() + 24 * 3600e3); // forget the room after a day of no activity
      },
    });
  }

  async fetch(request) {
    const code = new URL(request.url).pathname.split('/').pop().toUpperCase();
    if (!validCode(code)) return new Response('Bad room code', { status: 400 });
    if (!this.room) { this.code = code; await this.ctx.storage.put('code', code); this.room = this.makeRoom(code, null); }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener('message', (e) => this.room.message(server, typeof e.data === 'string' ? e.data : ''));
    const gone = () => this.room && this.room.close(server);
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    if (this.room && this.room.connectedCount() > 0) return this.ctx.storage.setAlarm(Date.now() + 24 * 3600e3);
    await this.ctx.storage.deleteAll();
    this.room = null;
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
