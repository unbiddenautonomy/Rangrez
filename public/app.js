// Rangrez client. Vanilla JS; talks to the server over one WebSocket.
const COLOR_NAMES = { R: 'Crimson', Y: 'Amber', G: 'Jade', B: 'Cobalt', P: 'Violet' };
const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const $app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ws, S = null, code = null, isHost = false;
let ui = { die: null, tool: null, from: null, trackDie: null };
let ME = null, myGames = [], clockSkew = 0; // logged-in user, their games, server-minus-local clock
const api = async (path, method = 'GET', body) => {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
};
async function loadMe() {
  const r = await api('/api/me');
  ME = r.ok ? r.data.user : null; myGames = r.ok ? r.data.games : [];
}

// One WebSocket per room: /ws/<CODE>. `first` is the message to send once it opens.
let wantRoom = null, firstMsg = null;
function connect(roomCode, first) {
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
  wantRoom = roomCode; firstMsg = first;
  if (!roomCode) return render();
  const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/' + roomCode);
  ws = sock;
  sock.onopen = () => { sock.send(JSON.stringify(firstMsg || { t: 'resume' })); firstMsg = null; };
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'joined') history.replaceState(null, '', '/' + m.code);
    else if (m.t === 'state') { const prevTurn = S && `${S.round}-${S.turn}`; S = m.state; code = m.code; isHost = m.host; clockSkew = S.now - Date.now(); if (prevTurn !== `${S.round}-${S.turn}`) resetUi(); render(); }
    else if (m.t === 'error') { toast(m.message); if (!S) leaveRoom(); }
    else if (m.t === 'resumeFailed') { const c = m.code; leaveRoom(); if (m.open) { joinCode = c; toast(`Room ${c} is open: press Join to take a seat`); render(); } else toast(`No game with code ${c} for you`); }
    else if (m.t === 'left') leaveRoom();
  };
  sock.onclose = () => { if (ws !== sock || !wantRoom) return; if (!S) { leaveRoom(); return toast('Could not open that room. Are you logged in?'); } toast('Connection lost, reconnecting…'); setTimeout(() => { if (ws === sock && wantRoom) connect(wantRoom); }, 1500); };
}
// Back to the home screen. Your seat in the game is kept; open it again from My games.
let joinCode = '';
async function leaveRoom() {
  S = null; code = null; wantRoom = null;
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
  history.replaceState(null, '', '/');
  await loadMe(); render();
}
async function createRoom() {
  for (let i = 0; i < 5; i++) {
    const { code: c } = await fetch('/api/new-room').then((r) => r.json());
    const ok = await new Promise((res) => {
      connect(c, { t: 'create' });
      const sock = ws, prev = sock.onmessage;
      sock.onmessage = (e) => { const m = JSON.parse(e.data); prev(e); if (m.t === 'joined') { sock.onmessage = prev; res(true); } else if (m.t === 'error') { res(false); } };
    });
    if (ok) return;
  }
}
const send = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
const act = (action) => send({ t: 'act', action });
function resetUi() { ui = { die: null, tool: null, from: null, trackDie: null }; }
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }

function dieHtml(d, attrs = '', cls = '') {
  const on = PIPS[d.value];
  return `<div class="die d-${d.color} ${cls}" data-v="${d.value}" ${attrs} title="${COLOR_NAMES[d.color]} ${d.value}">${[...Array(9)].map((_, i) => `<i class="${on.includes(i) ? 'on' : ''}"></i>`).join('')}</div>`;
}
function windowHtml(pattern, win, opts = {}) {
  let h = `<div class="window ${opts.small ? 'small' : ''}">`;
  for (let i = 0; i < 20; i++) {
    const req = pattern.rows[Math.floor(i / 5)][i % 5];
    const cls = req === '.' ? '' : /[1-6]/.test(req) ? 'v' : 'c-' + req;
    const d = win && win[i];
    const click = opts.clickable && opts.clickable(i, d);
    h += `<div class="cell ${cls} ${click ? 'clickable' : ''} ${opts.from === i ? 'from' : ''}" ${click ? `data-cell="${i}"` : ''}>`;
    if (d) h += dieHtml(d);
    else if (/[1-6]/.test(req)) h += dieHtml({ color: 'X', value: +req });
    h += '</div>';
  }
  return h + '</div>';
}
const dots = (n) => '●'.repeat(n);

// ---------- Pattern editor ----------
let editing = null;
const EDIT_CYCLE = ['.', 'R', 'Y', 'G', 'B', 'P', '1', '2', '3', '4', '5', '6'];
const blank = () => ({ name: '', difficulty: 4, rows: ['.....', '.....', '.....', '.....'] });
async function openEditor() {
  const r = await fetch('/api/patterns').then((x) => x.json());
  editing = { list: r.custom, builtin: r.builtin, cur: blank(), brush: 'R' };
  renderEditor();
}
async function savePatterns(body) {
  const r = await fetch('/api/patterns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
  if (r.error) return toast(r.error);
  editing.list = r.custom; editing.cur = blank(); toast('Saved'); renderEditor();
}
function renderEditor() {
  const E = editing, cur = E.cur;
  const brushHtml = EDIT_CYCLE.map((b) => `<div class="cell ${b === '.' ? '' : /[1-6]/.test(b) ? 'v' : 'c-' + b} clickable ${E.brush === b ? 'from' : ''}" data-brush="${b}" style="--cell:40px">${/[1-6]/.test(b) ? dieHtml({ color: 'X', value: +b }) : b === '.' ? '<span class="muted">open</span>' : ''}</div>`).join('');
  $app.innerHTML = `<div class="stack">
  <div class="panel">
    <h2>${cur.id ? 'Edit' : 'New'} window pattern</h2>
    <p class="muted">Pick a brush, then click cells to paint them. Clicking a cell that already has the brush clears it.</p>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${brushHtml}</div>
    ${windowHtml(cur, null, { clickable: () => true })}
    <div class="row" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <input id="pname" placeholder="Pattern name" maxlength="40" value="${esc(cur.name)}">
      <select id="pdiff">${[3, 4, 5, 6].map((d) => `<option ${+cur.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <button class="primary" id="psave">Save pattern</button>
      ${cur.id ? '<button id="pnew">New blank</button>' : ''}
    </div>
    <p class="legend">Difficulty is also the number of favor tokens the player gets.</p>
  </div>
  <div class="panel">
    <h2>My custom patterns (${E.list.length})</h2>
    <div class="patterns">${E.list.map((p) => `<div class="pchoice" style="cursor:default">${windowHtml(p, null, { small: true })}<div class="pn">${esc(p.name)}</div><div class="dots">${dots(p.difficulty)}</div>
      <button data-edit="${p.id}">Edit</button> <button data-del="${p.id}">Delete</button></div>`).join('') || '<span class="muted">None yet.</span>'}</div>
    <h3 style="margin-top:14px">Import / export JSON</h3>
    <p class="muted">Format: a list of {"name", "difficulty" 3-6, "rows": 4 strings of 5 characters}. Use . for open, R Y G B P for colors, 1-6 for values.</p>
    <textarea id="pjson" rows="6" style="width:100%;font-family:monospace;font-size:13px" placeholder='[{"name":"My Window","difficulty":4,"rows":["R...3",".G.4.","..B..","1...Y"]}]'></textarea>
    <p><button id="pimport">Import</button> <button id="pexport">Export mine</button> <button id="pback">Back</button></p>
  </div></div>`;
  const q = (sel, fn) => $app.querySelectorAll(sel).forEach((el) => (el.onclick = () => fn(el)));
  const keep = () => { cur.name = document.getElementById('pname').value; cur.difficulty = +document.getElementById('pdiff').value; };
  q('[data-brush]', (el) => { keep(); E.brush = el.dataset.brush; renderEditor(); });
  q('[data-cell]', (el) => {
    keep(); const i = +el.dataset.cell, r = Math.floor(i / 5), c = i % 5, row = cur.rows[r].split('');
    row[c] = row[c] === E.brush ? '.' : E.brush; cur.rows = cur.rows.map((x, k) => (k === r ? row.join('') : x)); renderEditor();
  });
  q('#psave', () => { keep(); savePatterns(cur); });
  q('#pnew', () => { E.cur = blank(); renderEditor(); });
  q('[data-edit]', (el) => { E.cur = JSON.parse(JSON.stringify(E.list.find((p) => p.id === el.dataset.edit))); renderEditor(); });
  q('[data-del]', async (el) => { const r = await fetch('/api/patterns/' + el.dataset.del, { method: 'DELETE' }).then((x) => x.json()); E.list = r.custom; renderEditor(); });
  q('#pimport', () => { try { savePatterns(JSON.parse(document.getElementById('pjson').value)); } catch { toast('That is not valid JSON'); } });
  q('#pexport', () => { document.getElementById('pjson').value = JSON.stringify(E.list.map(({ name, difficulty, rows }) => ({ name, difficulty, rows })), null, 1); });
  q('#pback', () => { editing = null; render(); });
}

// ---------- Window gallery ----------
let gallery = null;
async function openGallery() {
  const r = await fetch('/api/patterns').then((x) => x.json());
  gallery = { builtin: r.builtin, custom: r.custom };
  render();
}
function renderGallery() {
  const G = gallery, tiers = [3, 4, 5, 6];
  const group = (list) => tiers.map((d) => {
    const ps = list.filter((p) => p.difficulty === d);
    return ps.length ? `<h3 style="margin-top:16px">Difficulty ${d} <span class="dots">${dots(d)}</span> <span class="muted">${ps.length} windows</span></h3>
      <div class="gallery">${ps.map((p) => `<div class="gcard">${windowHtml(p, null, { small: true })}<div class="pn">${esc(p.name)}</div></div>`).join('')}</div>` : '';
  }).join('');
  $app.innerHTML = `<div class="panel">
    <h2>Window gallery</h2>
    <p class="muted">Each game deals every player one window from each difficulty. Harder windows have more color and number squares and give more favor tokens. Tinted squares need that color, faded dice need that number.</p>
    <p><button id="gback">Back</button></p>
    ${group(G.builtin)}
    ${G.custom.length ? `<h2 style="margin-top:24px">Your custom windows</h2>${group(G.custom)}` : ''}
  </div>`;
  document.getElementById('gback').onclick = () => { gallery = null; render(); };
}

function render() {
  if (gallery && !S) return renderGallery();
  if (editing && !S) return renderEditor();
  document.getElementById('roomInfo').innerHTML = (code ? `<span class="muted">Room</span> <span class="code">${code}</span> <button id="copy">Copy link</button> <button id="home">My games</button>` : '')
    + (ME && !code ? `<span class="muted">${esc(ME.name)}</span> <button id="logout">Log out</button>` : '');
  const c = document.getElementById('copy'); if (c) c.onclick = () => { navigator.clipboard?.writeText(location.origin + '/' + code); toast('Link copied'); };
  const h = document.getElementById('home'); if (h) h.onclick = () => leaveRoom();
  const lo = document.getElementById('logout'); if (lo) lo.onclick = async () => { await api('/api/logout', 'POST'); ME = null; myGames = []; render(); };
  if (!ME) return renderAuth();
  if (!S) return renderHome();
  ({ lobby: renderLobby, choosing: renderChoosing, playing: renderGame, ended: renderEnd })[S.phase]();
}

function renderAuth() {
  $app.innerHTML = `<div class="home panel">
    <h2>Draft dice. Build a window.</h2>
    <p class="muted">A dice-drafting game for 1 to 4 players, with friends or bots. Log in so you can leave a game and continue it later, even days later, from any device.</p>
    <input id="uname" placeholder="Name" maxlength="20" autocomplete="username">
    <input id="upass" type="password" placeholder="Password (6+ characters)" autocomplete="current-password">
    <div class="row"><button class="primary" id="login" style="flex:1">Log in</button><button id="register" style="flex:1">Create account</button></div>
    <button id="gallery">Browse all 64 windows</button>
  </div>`;
  const go = async (path) => {
    const r = await api(path, 'POST', { name: document.getElementById('uname').value, password: document.getElementById('upass').value });
    if (!r.ok) return toast(r.data.error || 'Something went wrong');
    await loadMe(); const c = urlCode(); if (c) connect(c); else render();
  };
  document.getElementById('login').onclick = () => go('/api/login');
  document.getElementById('register').onclick = () => go('/api/register');
  document.getElementById('upass').onkeydown = (e) => { if (e.key === 'Enter') go('/api/login'); };
  document.getElementById('gallery').onclick = () => openGallery();
}

const urlCode = () => { const c = location.pathname.slice(1).toUpperCase(); return /^[A-Z]{4}$/.test(c) ? c : null; };
function gameLine(g) {
  const yours = g.phase === 'playing' && g.turnUserId === ME.id;
  const status = g.phase === 'lobby' ? 'Waiting room' : g.phase === 'choosing' ? 'Choosing windows' : g.phase === 'ended' ? `Finished · ${esc(g.winner)} won` : yours ? '<b class="yourturn">Your turn</b>' : `Round ${g.round}/10 · ${esc(g.turnName)}'s turn`;
  const when = new Date(g.updated).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<div class="gameline ${yours ? 'mine' : ''}"><div><span class="code" style="font-size:16px">${g.code}</span> ${g.mode === 'timed' ? '⏱' : ''} <span>${status}</span>
    <div class="muted">${g.players.map(esc).join(', ')} · ${when}</div></div>
    <div><button class="primary" data-open="${g.code}">${g.phase === 'ended' ? 'View' : 'Open'}</button> <button data-forget="${g.code}" title="Remove from my list">✕</button></div></div>`;
}
function renderHome() {
  const c0 = joinCode || ''; joinCode = '';
  $app.innerHTML = `<div class="home panel">
    <h2>Hi ${esc(ME.name)}</h2>
    <button class="primary" id="create">Create a room</button>
    <div class="row"><input id="code" placeholder="Room code" maxlength="4" value="${c0}"><button id="join">Join</button></div>
    <h3 style="margin-top:8px">My games</h3>
    <div class="games">${myGames.map(gameLine).join('') || '<span class="muted">No games yet. Games you join show up here, so you can pick them up again any time.</span>'}</div>
    <button id="gallery">Browse all 64 windows</button>
    <button id="editor">Pattern editor (add your own windows)</button>
  </div>`;
  document.getElementById('editor').onclick = () => openEditor();
  document.getElementById('gallery').onclick = () => openGallery();
  document.getElementById('create').onclick = () => createRoom();
  document.getElementById('join').onclick = () => { const c = document.getElementById('code').value.toUpperCase().trim(); if (!/^[A-Z]{4}$/.test(c)) return toast('Room codes are 4 letters'); connect(c, { t: 'join' }); };
  $app.querySelectorAll('[data-open]').forEach((el) => (el.onclick = () => connect(el.dataset.open)));
  $app.querySelectorAll('[data-forget]').forEach((el) => (el.onclick = async () => { const r = await api('/api/games/' + el.dataset.forget, 'DELETE'); if (r.ok) { myGames = r.data.games; render(); } }));
}
function renderLobby() {
  $app.innerHTML = `<div class="home panel">
    <h2>Waiting room</h2>
    <p class="muted">Share the code <span class="code">${code}</span> or the link. Players on any device can join until the host starts. Everyone needs an account.</p>
    <ul class="players">${S.players.map((p, i) => `<li>${esc(p.name)} ${i === 0 ? '<span class="muted">(host)</span>' : ''} ${p.bot ? '<span class="muted">bot</span>' : ''} ${p.connected ? '' : '<span class="off">offline</span>'} ${isHost && p.bot ? `<button data-rmbot="${i}">Remove</button>` : ''}</li>`).join('')}</ul>
    ${isHost && S.players.length < 4 ? `<p>Add a bot: <button data-addbot="easy">Easy</button> <button data-addbot="medium">Medium</button> <button data-addbot="hard">Hard</button></p><p class="muted">Play solo against bots, or fill empty seats while friends join.</p>` : ''}
    <p>Turn timer: ${isHost ? `<select id="mode"><option value="untimed" ${S.mode === 'untimed' ? 'selected' : ''}>No timer (play over days)</option><option value="timed" ${S.mode === 'timed' ? 'selected' : ''}>2 minutes per turn</option></select>` : `<b>${S.mode === 'timed' ? '2 minutes per turn' : 'No timer'}</b>`}</p>
    <p>Window patterns: ${isHost ? `<select id="pset">${[['original', 'Rangrez originals'], ['custom', 'My custom patterns'], ['both', 'Both']].map(([v, l]) => `<option value="${v}" ${S.patternSet === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : `<b>${{ original: 'Rangrez originals', custom: 'Custom patterns', both: 'Originals + custom' }[S.patternSet]}</b>`}</p>
    ${isHost ? `<button class="primary" id="start">Start game (${S.players.length} player${S.players.length > 1 ? 's' : ''})</button>` : '<p class="muted">Waiting for the host to start…</p>'}
    <button id="leave">Leave room</button>
  </div>`;
  if (isHost) {
    document.getElementById('start').onclick = () => send({ t: 'start' });
    document.getElementById('pset').onchange = (e) => send({ t: 'options', patternSet: e.target.value });
    document.getElementById('mode').onchange = (e) => send({ t: 'options', mode: e.target.value });
    $app.querySelectorAll('[data-addbot]').forEach((el) => (el.onclick = () => send({ t: 'addBot', level: el.dataset.addbot })));
    $app.querySelectorAll('[data-rmbot]').forEach((el) => (el.onclick = () => send({ t: 'removeBot', seat: +el.dataset.rmbot })));
  }
  document.getElementById('leave').onclick = () => send({ t: 'leave' });
}

function secretHtml(p) { return p.secret ? `<span class="secret" style="background:var(--${p.secret})"></span> ${COLOR_NAMES[p.secret]}` : '?'; }

function renderChoosing() {
  const me = S.players[S.you];
  $app.innerHTML = `<div class="panel">
    <h2>Choose your window</h2>
    <p class="muted">Your secret color is ${secretHtml(me)}: at the end you score the total pips of that color. Harder windows have more restrictions and give more favor tokens (●) for tools.</p>
    ${me.ready ? `<p>You chose <b>${esc(me.pattern.name)}</b>. Waiting for: ${S.players.filter((p) => !p.ready).map((p) => esc(p.name)).join(', ')}</p>` : `
    <div class="patterns">${me.choices.map((p) => `<div class="pchoice" data-pid="${p.id}">${windowHtml(p, null)}<div class="pn">${esc(p.name)}</div><div class="dots">${dots(p.difficulty)}</div><div class="muted">Difficulty ${p.difficulty}</div></div>`).join('')}</div>`}
    <p class="legend">Tinted cells need that color. Faded dice need that value. Open cells take anything.</p>
  </div>`;
  $app.querySelectorAll('[data-pid]').forEach((el) => (el.onclick = () => send({ t: 'choose', patternId: el.dataset.pid })));
}

const TOOL_HELP = {
  chisel: 'Pick a pool die, then press + or −.', recast: 'Pick a pool die, then press Use.', flip: 'Pick a pool die, then press Use.',
  swapTrack: 'Pick a pool die and a round-track die, then press Use.', stir: 'Press Use to reroll the pool.',
  leadKnife: 'Click a die in your window, then its new cell.', file: 'Click a die in your window, then its new cell.',
  loose: 'Pick a pool die, then click any cell not touching a die.',
};

function renderGame() {
  const me = S.players[S.you], mine = S.current === S.you, cur = S.players[S.current];
  const moving = ui.tool === 'leadKnife' || ui.tool === 'file';
  const canPlace = mine && !me.placed;
  const clickable = (i, d) => {
    if (!mine) return false;
    if (moving) return ui.from === null ? !!d : !d;
    return canPlace && ui.die !== null && !d;
  };
  const orderNames = S.order.map((pi, k) => `<span style="${k === S.turn ? 'color:var(--gold);font-weight:700' : k < S.turn ? 'opacity:.4' : ''}">${esc(S.players[pi].name)}</span>`).join(' → ');

  $app.innerHTML = `
  <div class="turnbar ${mine ? 'mine' : ''}">
    <div><b>Round ${S.round}/${S.rounds}</b> · ${mine ? 'Your turn' : `${esc(cur.name)}'s turn`} ${mine && S.secondTurn ? '(second pick)' : ''}<div class="muted">${orderNames}</div></div>
    <div style="display:flex;gap:10px;align-items:center">${S.deadline ? '<span id="clock" class="clock"></span>' : ''}${mine ? `<button class="primary" id="pass">${me.placed ? 'End turn' : 'Pass'}</button>` : ''}</div>
  </div>
  <div class="game" style="margin-top:14px">
    <div class="stack">
      <div class="panel">
        <h3>Draft pool</h3>
        <div class="pool">${S.pool.map((d) => dieHtml(d, `data-die="${d.id}"`, (ui.die === d.id ? 'sel ' : '') + (S.lock === d.id ? 'locked' : ''))).join('') || '<span class="muted">Empty</span>'}</div>
        <p class="muted">${mine ? (me.placed ? 'Die placed. Use a tool or end your turn.' : ui.tool ? TOOL_HELP[ui.tool] : 'Pick a die, then click a cell in your window.') : (cur.bot ? esc(cur.name) + ' is thinking…' : 'Waiting for ' + esc(cur.name) + '…')}${S.lock ? ' The gold-ringed die was changed and must be the one you draft.' : ''}</p>
      </div>
      <div class="panel" style="text-align:center">
        <h3>${esc(me.name)} · ${esc(me.pattern.name)}</h3>
        ${windowHtml(me.pattern, me.window, { clickable, from: ui.from })}
        <p class="muted">Favor <span class="favor">${dots(me.favor) || '0'}</span> · Secret color ${secretHtml(me)}</p>
        <p class="legend">First die on an edge. Later dice must touch a placed die (diagonals count). Same color or value can never sit side by side.</p>
      </div>
    </div>
    <div class="stack">
      <div class="panel"><h3>Other windows</h3><div class="others">${S.players.map((p, i) => i === S.you ? '' : `<div class="other ${S.current === i ? 'active' : ''}"><div class="nm">${esc(p.name)} <span class="favor">${dots(p.favor)}</span> ${p.connected ? '' : '<span class="off">offline</span>'}</div>${windowHtml(p.pattern, p.window, { small: true })}<div class="muted">${esc(p.pattern.name)}</div></div>`).join('') || '<span class="muted">Solo game</span>'}</div></div>
      <div class="panel"><h3>Tools</h3><div class="cards">${S.tools.map((t) => `
        <div class="card tool ${ui.tool === t.id ? 'armed' : ''}"><div><b>${esc(t.name)}</b> <span class="favor">${dots(t.cost)}</span><div class="muted">${esc(t.text)}</div></div>
        <div>${mine && ui.tool === t.id ? toolButtons(t.id) : `<button data-tool="${t.id}" ${!mine || me.toolUsed || me.favor < t.cost ? 'disabled' : ''}>Use</button>`}</div></div>`).join('')}</div></div>
      <div class="panel"><h3>Public objectives</h3><div class="cards">${S.objectives.map((o) => `<div class="card"><b>${esc(o.name)}</b> · ${esc(o.pts)}<div class="muted">${esc(o.text)}</div></div>`).join('')}</div></div>
      <div class="panel"><h3>Round track</h3><div class="track">${S.track.map((r, ri) => `<div class="slot">${ri + 1}${r.map((d) => dieHtml(d, `data-tr="${ri}" data-trd="${d.id}"`, ui.trackDie && ui.trackDie.id === d.id ? 'sel' : '')).join('')}</div>`).join('') || '<span class="muted">Leftover dice land here each round.</span>'}</div></div>
      <div class="panel"><h3>Log</h3><div class="log">${S.log.slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('')}</div></div>
    </div>
  </div>`;
  bindGame(me);
}

function toolButtons(id) {
  const go = (label, extra = '') => `<button class="primary" data-go="${id}" ${extra}>${label}</button>`;
  let b = '';
  if (id === 'chisel') b = go('−', 'data-dir="-1"') + ' ' + go('+', 'data-dir="1"');
  else if (['recast', 'flip', 'swapTrack', 'stir'].includes(id)) b = go('Use');
  return `${b} <button data-cancel>Cancel</button>`;
}

function bindGame(me) {
  const q = (sel, fn) => $app.querySelectorAll(sel).forEach((el) => (el.onclick = () => fn(el)));
  const pass = document.getElementById('pass'); if (pass) pass.onclick = () => act({ type: 'pass' });
  q('[data-die]', (el) => { ui.die = +el.dataset.die; render(); });
  q('[data-trd]', (el) => { ui.trackDie = { round: +el.dataset.tr, id: +el.dataset.trd }; render(); });
  q('[data-tool]', (el) => { ui.tool = el.dataset.tool; ui.from = null; render(); });
  q('[data-cancel]', () => { ui.tool = null; ui.from = null; render(); });
  q('[data-go]', (el) => {
    const t = el.dataset.go;
    if (t !== 'stir' && ui.die === null) return toast('Pick a die from the pool first');
    if (t === 'swapTrack' && !ui.trackDie) return toast('Pick a die on the round track too');
    act({ type: 'tool', tool: t, dieId: ui.die, dir: +el.dataset.dir || 0, trackRound: ui.trackDie?.round, trackDieId: ui.trackDie?.id });
    if (t === 'swapTrack') ui.die = ui.trackDie.id;
    ui.tool = null; ui.trackDie = null;
  });
  q('[data-cell]', (el) => {
    const cell = +el.dataset.cell;
    if (ui.tool === 'leadKnife' || ui.tool === 'file') {
      if (ui.from === null) { ui.from = cell; return render(); }
      act({ type: 'tool', tool: ui.tool, from: ui.from, to: cell }); ui.tool = null; ui.from = null; return;
    }
    act({ type: 'place', dieId: ui.die, cell, tool: ui.tool === 'loose' ? 'loose' : undefined });
    ui.tool = null;
  });
}

function renderEnd() {
  const objs = S.objectives;
  $app.innerHTML = `<div class="panel">
    <h2>${esc(S.results[0].name)} wins!</h2>
    <table><tr><th>Player</th>${objs.map((o) => `<th>${esc(o.name)}</th>`).join('')}<th>Secret color</th><th>Favor</th><th>Empty</th><th>Total</th></tr>
    ${S.results.map((r) => `<tr><td>${esc(r.name)}</td>${r.pub.map((x) => `<td>${x.pts}</td>`).join('')}<td>${r.priv} ${secretHtml(S.players[r.i])}</td><td>${r.favor}</td><td>${r.empty}</td><td><b>${r.total}</b></td></tr>`).join('')}</table>
    <div class="others" style="margin-top:16px">${S.players.map((p) => `<div class="other"><div class="nm">${esc(p.name)}</div>${windowHtml(p.pattern, p.window, { small: true })}</div>`).join('')}</div>
    <p><button id="again">Back to start</button></p>
  </div>`;
  document.getElementById('again').onclick = () => leaveRoom();
}

// Dice skin: purely visual, remembered on this device.
function applySkin(v) { document.body.dataset.skin = v; localStorage.setItem('gw-skin', v); }
{ const sel = document.getElementById('skin'); sel.value = localStorage.getItem('gw-skin') || 'classic'; applySkin(sel.value); sel.onchange = () => applySkin(sel.value); }
// Turn clock for timed games.
setInterval(() => {
  const el = document.getElementById('clock');
  if (!el || !S || !S.deadline) return;
  const left = Math.max(0, Math.round((S.deadline - (Date.now() + clockSkew)) / 1000));
  el.textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  el.classList.toggle('low', left <= 20);
}, 250);

// Start: who am I? Then open the room in the URL, if any.
loadMe().then(() => { const c = urlCode(); if (ME && c) connect(c); else render(); });
