// Plays a full game with bots over real WebSockets against a running server.
// Usage: PORT=3000 node tools/simulate.js [players]   (or HOST=localhost:8787 for wrangler dev)
const WebSocket = require('ws');
const { checkPlacement } = require('../server/game');
const HOST = process.env.HOST || 'localhost:' + (process.env.PORT || 3000);
const N = +process.argv[2] || 3;
const bots = []; let code;
async function bot(name, create) {
  if (create) code = (await fetch('http://' + HOST + '/api/new-room').then((r) => r.json())).code;
  return new Promise((res) => {
    const ws = new WebSocket('ws://' + HOST + '/ws/' + code); const b = { ws, name, state: null, errors: 0 };
    ws.on('open', () => ws.send(JSON.stringify(create ? { t: 'create', name } : { t: 'join', name })));
    ws.on('message', (raw) => { const m = JSON.parse(raw);
      if (m.t === 'joined') { code = m.code; res(b); }
      if (m.t === 'error') { b.errors++; console.log(name, 'error:', m.message); }
      if (m.t === 'state') { b.state = m.state; b.host = m.host; think(b); } });
  });
}
const send = (b, m) => b.ws.send(JSON.stringify(m));
let toolTried = false;
function think(b) {
  const S = b.state, me = S.players[S.you];
  if (S.phase === 'choosing' && !me.ready) return send(b, { t: 'choose', patternId: me.choices[S.you % 4].id });
  if (S.phase === 'ended') { done(S); return; }
  if (S.phase !== 'playing' || S.current !== S.you) return;
  if (!me.placed) {
    if (!toolTried && S.round === 2 && me.favor > 0 && !me.toolUsed) { toolTried = true; const t = S.tools.find(t=>['flip','recast','chisel','swapTrack'].includes(t.id)); if (t) return send(b,{t:'act',action:{type:'tool',tool:t.id,dieId:S.pool[0].id,dir:1,trackRound:0,trackDieId:S.track[0]&&S.track[0][0].id}}); }
    const dice = S.lock ? S.pool.filter(d=>d.id===S.lock) : S.pool;
    for (const d of dice) for (let c = 0; c < 20; c++) if (!checkPlacement(me.window, me.pattern, d, c)) return send(b, { t: 'act', action: { type: 'place', dieId: d.id, cell: c } });
  }
  send(b, { t: 'act', action: { type: 'pass' } });
}
let finished = 0;
function done(S) { if (++finished < N) return; console.log('RESULTS', JSON.stringify(S.results.map(r=>({n:r.name,total:r.total,pub:r.pub.map(x=>x.pts),priv:r.priv,favor:r.favor,empty:r.empty})))); console.log('LOG tail:', S.log.slice(-4)); console.log('errors', bots.map(b=>b.errors)); process.exit(0); }
(async () => {
  bots.push(await bot('Ada', true));
  for (let i = 1; i < N; i++) bots.push(await bot('Bot' + i));
  console.log('room', code); send(bots[0], { t: 'start' });
  setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 20000);
})();
