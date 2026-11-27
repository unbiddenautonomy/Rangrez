// Kaanch Mahal rules engine. Pure state + actions; the server wires it to sockets.
const PATTERNS = require('./patterns');

const ROWS = 4, COLS = 5, CELLS = 20, ROUNDS = 10;
const COLORS = ['R', 'Y', 'G', 'B', 'P'];
const COLOR_NAMES = { R: 'Crimson', Y: 'Amber', G: 'Jade', B: 'Cobalt', P: 'Violet' };

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const d6 = () => 1 + Math.floor(Math.random() * 6);
const rc = (i) => [Math.floor(i / COLS), i % COLS];
const idx = (r, c) => r * COLS + c;
const inside = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
const orth = (i) => { const [r, c] = rc(i); return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => [r + a, c + b]).filter(([x, y]) => inside(x, y)).map(([x, y]) => idx(x, y)); };
const around = (i) => { const out = []; const [r, c] = rc(i); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if ((a || b) && inside(r + a, c + b)) out.push(idx(r + a, c + b)); return out; };
const diag = (i) => { const [r, c] = rc(i); return [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => [r + a, c + b]).filter(([x, y]) => inside(x, y)).map(([x, y]) => idx(x, y)); };
const isEdge = (i) => { const [r, c] = rc(i); return r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1; };
const patternCell = (p, i) => { const ch = p.rows[Math.floor(i / COLS)][i % COLS]; return ch === '.' ? null : ch; };

// ---------- Public objectives (original names; scoring concepts common to the genre) ----------
const rowsOf = (w) => [...Array(ROWS)].map((_, r) => [...Array(COLS)].map((_, c) => w[idx(r, c)]));
const colsOf = (w) => [...Array(COLS)].map((_, c) => [...Array(ROWS)].map((_, r) => w[idx(r, c)]));
const allDistinct = (line, key) => line.every(Boolean) && new Set(line.map((d) => d[key])).size === line.length;
const countBy = (w, key, vals) => vals.map((v) => w.filter((d) => d && d[key] === v).length);
const OBJECTIVES = {
  prismRows: { name: 'Prismatic Rows', text: 'Full rows with no repeated color', pts: '6 each', score: (w) => 6 * rowsOf(w).filter((l) => allDistinct(l, 'color')).length },
  prismCols: { name: 'Prismatic Columns', text: 'Full columns with no repeated color', pts: '5 each', score: (w) => 5 * colsOf(w).filter((l) => allDistinct(l, 'color')).length },
  numRows: { name: 'Numeral Rows', text: 'Full rows with no repeated value', pts: '5 each', score: (w) => 5 * rowsOf(w).filter((l) => allDistinct(l, 'value')).length },
  numCols: { name: 'Numeral Columns', text: 'Full columns with no repeated value', pts: '4 each', score: (w) => 4 * colsOf(w).filter((l) => allDistinct(l, 'value')).length },
  lowPair: { name: 'Dawn Pairs', text: 'Sets of one 1 and one 2', pts: '2 per set', score: (w) => 2 * Math.min(...countBy(w, 'value', [1, 2])) },
  midPair: { name: 'Noon Pairs', text: 'Sets of one 3 and one 4', pts: '2 per set', score: (w) => 2 * Math.min(...countBy(w, 'value', [3, 4])) },
  highPair: { name: 'Dusk Pairs', text: 'Sets of one 5 and one 6', pts: '2 per set', score: (w) => 2 * Math.min(...countBy(w, 'value', [5, 6])) },
  allValues: { name: 'Full Count', text: 'Sets of all six values', pts: '5 per set', score: (w) => 5 * Math.min(...countBy(w, 'value', [1, 2, 3, 4, 5, 6])) },
  allColors: { name: 'Full Palette', text: 'Sets of all five colors', pts: '4 per set', score: (w) => 4 * Math.min(...countBy(w, 'color', COLORS)) },
  chains: { name: 'Leaded Chains', text: 'Dice diagonally touching a die of the same color', pts: '1 each', score: (w) => w.filter((d, i) => d && diag(i).some((j) => w[j] && w[j].color === d.color)).length },
};

// ---------- Tools (original names; effects common to the genre) ----------
const TOOLS = {
  chisel: { name: 'Chisel', text: 'Raise or lower a pool die by 1 (no wrapping 6↔1), then you must draft that die.' },
  recast: { name: 'Recast', text: 'Reroll a pool die, then you must draft that die.' },
  flip: { name: 'Turn the Glass', text: 'Flip a pool die to its opposite face (1↔6, 2↔5, 3↔4), then you must draft that die.' },
  leadKnife: { name: 'Lead Knife', text: 'Move one die in your window, ignoring color restrictions.' },
  file: { name: "Glazier's File", text: 'Move one die in your window, ignoring value restrictions.' },
  swapTrack: { name: 'Time Pane', text: 'Swap a pool die with a die on the round track, then you must draft it.' },
  stir: { name: 'Stir the Kiln', text: 'Reroll every die in the pool. Only on your second turn of a round, before drafting.' },
  loose: { name: 'Loose Pane', text: 'Place your drafted die in a cell not touching any other die.' },
};

// Patterns entered by the user (e.g. from cards they own). Kept in memory, loaded/saved by the server.
let customPatterns = [];
function setCustomPatterns(list) { customPatterns = list; }
function validatePattern(p) {
  const name = String(p.name || '').trim().slice(0, 40);
  const difficulty = +p.difficulty;
  if (!name) throw new Error('Pattern needs a name');
  if (![3, 4, 5, 6].includes(difficulty)) throw new Error('Difficulty must be 3, 4, 5 or 6');
  const rows = Array.isArray(p.rows) ? p.rows.map((r) => String(r).toUpperCase()) : [];
  if (rows.length !== ROWS || rows.some((r) => !/^[.RYGBP1-6]{5}$/.test(r))) throw new Error('Rows must be 4 strings of 5 characters using . R Y G B P 1-6');
  return { name, difficulty, rows };
}

function newGameState() {
  return { phase: 'lobby', players: [], round: 0, order: [], turn: 0, pool: [], track: [], bag: [], objectives: [], tools: [], log: [], nextDieId: 1, results: null, firstPlayer: 0 };
}

function addPlayer(g, id, name) {
  if (g.phase !== 'lobby') throw new Error('Game already started');
  if (g.players.length >= 4) throw new Error('Room is full (4 players)');
  g.players.push({ id, name, window: Array(CELLS).fill(null), pattern: null, choices: [], favor: 0, secret: null, connected: true, placed: false, toolUsed: false });
}

function log(g, msg) { g.log.push(msg); if (g.log.length > 60) g.log.shift(); }

function start(g) {
  if (g.phase !== 'lobby') throw new Error('Already started');
  if (g.players.length < 1) throw new Error('Need players');
  // Snapshot the pattern set for this game: built-in, custom (user-entered), or both.
  const set = g.patternSet || 'original';
  const list = [...(set !== 'custom' ? PATTERNS : []), ...(set !== 'original' ? customPatterns : [])];
  if (!list.length) throw new Error('No custom patterns saved yet. Add some in the pattern editor or pick another set.');
  g.patterns = Object.fromEntries(list.map((p) => [p.id, p]));
  g.phase = 'choosing';
  // Deal each player one pattern per difficulty tier (4 choices), falling back to any unused pattern.
  const unused = shuffle([...list]);
  const take = (pred) => { const k = unused.findIndex(pred); return k >= 0 ? unused.splice(k, 1)[0] : null; };
  const secrets = shuffle([...COLORS]);
  g.players.forEach((p, i) => {
    p.choices = [3, 4, 5, 6].map((d) => take((x) => x.difficulty === d) || take(() => true) || list[Math.floor(Math.random() * list.length)]).map((x) => x.id);
    p.choices = [...new Set(p.choices)];
    p.secret = secrets[i];
  });
  g.objectives = shuffle(Object.keys(OBJECTIVES)).slice(0, 3);
  g.tools = shuffle(Object.keys(TOOLS)).slice(0, 3).map((id) => ({ id, used: false }));
  g.bag = shuffle(COLORS.flatMap((c) => Array(18).fill(c)));
  g.firstPlayer = Math.floor(Math.random() * g.players.length);
  log(g, 'Everyone picks a window pattern.');
}

function choosePattern(g, pi, patternId) {
  if (g.phase !== 'choosing') throw new Error('Not choosing patterns now');
  const p = g.players[pi];
  const id = p.choices.find((c) => String(c) === String(patternId));
  if (id === undefined) throw new Error('Not one of your choices');
  p.pattern = id; patternId = id; p.favor = g.patterns[patternId].difficulty;
  if (g.players.every((x) => x.pattern !== null)) beginRound(g, 1);
}

function drawDie(g) { const color = g.bag.pop(); return { id: g.nextDieId++, color, value: d6() }; }

function beginRound(g, n) {
  g.phase = 'playing'; g.round = n;
  const N = g.players.length, s = (g.firstPlayer + n - 1) % N;
  const fwd = [...Array(N)].map((_, i) => (s + i) % N);
  g.order = [...fwd, ...[...fwd].reverse()];
  g.turn = 0;
  g.pool = [...Array(2 * N + 1)].map(() => drawDie(g));
  resetTurn(g);
  log(g, `Round ${n} begins.`);
}

function resetTurn(g) { g.players.forEach((p) => { p.placed = false; p.toolUsed = false; }); g.lock = null; }
const current = (g) => g.order[g.turn];
const isSecondTurn = (g) => g.turn >= g.players.length;

function checkPlacement(win, pattern, die, cell, opt = {}) {
  if (cell < 0 || cell >= CELLS || win[cell]) return 'That cell is taken';
  const empty = win.every((d) => !d);
  if (empty) { if (!isEdge(cell)) return 'Your first die must go on an edge or corner'; }
  else if (opt.noAdj) { if (around(cell).some((j) => win[j])) return 'Loose Pane: the cell must not touch any die'; }
  else if (!around(cell).some((j) => win[j])) return 'Dice must touch an existing die (including diagonally)';
  const req = patternCell(pattern, cell);
  if (req && COLORS.includes(req) && !opt.ignoreColor && die.color !== req) return `That cell needs ${COLOR_NAMES[req]}`;
  if (req && /[1-6]/.test(req) && !opt.ignoreValue && die.value !== +req) return `That cell needs a ${req}`;
  for (const j of orth(cell)) {
    if (!win[j]) continue;
    if (win[j].color === die.color) return 'Same colors cannot sit side by side';
    if (win[j].value === die.value) return 'Same values cannot sit side by side';
  }
  return null;
}

function useFavor(g, p, toolId) {
  const t = g.tools.find((x) => x.id === toolId);
  if (!t) throw new Error('That tool is not in this game');
  if (p.toolUsed) throw new Error('You already used a tool this turn');
  const cost = t.used ? 2 : 1;
  if (p.favor < cost) throw new Error(`Needs ${cost} favor token${cost > 1 ? 's' : ''}`);
  return () => { p.favor -= cost; t.used = true; p.toolUsed = true; log(g, `${p.name} used ${TOOLS[toolId].name} (${cost} favor).`); };
}

function act(g, pi, a) {
  if (g.phase !== 'playing') throw new Error('Game is not in play');
  if (current(g) !== pi) throw new Error('Not your turn');
  const p = g.players[pi], pat = g.patterns[p.pattern];
  const poolDie = (id) => { const d = g.pool.find((x) => x.id === id); if (!d) throw new Error('Die not in pool'); return d; };

  if (a.type === 'place') {
    if (p.placed) throw new Error('You already placed a die this turn');
    if (g.lock && g.lock !== a.dieId) throw new Error('You must draft the die you changed');
    const d = poolDie(a.dieId);
    let commit = null;
    if (a.tool === 'loose') commit = useFavor(g, p, 'loose');
    const err = checkPlacement(p.window, pat, d, a.cell, { noAdj: a.tool === 'loose' && p.window.some(Boolean) });
    if (err) throw new Error(err);
    if (commit) commit();
    p.window[a.cell] = d; g.pool = g.pool.filter((x) => x.id !== d.id); p.placed = true; g.lock = null;
    log(g, `${p.name} placed a ${COLOR_NAMES[d.color]} ${d.value}.`);
    return;
  }
  if (a.type === 'tool') {
    const commit = useFavor(g, p, a.tool);
    const needUnplaced = () => { if (p.placed) throw new Error('Use this before drafting'); };
    switch (a.tool) {
      case 'chisel': { needUnplaced(); const d = poolDie(a.dieId); const v = d.value + (a.dir > 0 ? 1 : -1); if (v < 1 || v > 6) throw new Error('Cannot go past 1 or 6'); commit(); d.value = v; g.lock = d.id; break; }
      case 'recast': { needUnplaced(); const d = poolDie(a.dieId); commit(); d.value = d6(); g.lock = d.id; break; }
      case 'flip': { needUnplaced(); const d = poolDie(a.dieId); commit(); d.value = 7 - d.value; g.lock = d.id; break; }
      case 'swapTrack': {
        needUnplaced(); const d = poolDie(a.dieId);
        const r = g.track[a.trackRound]; const td = r && r.find((x) => x.id === a.trackDieId);
        if (!td) throw new Error('Pick a die on the round track');
        commit(); g.pool[g.pool.indexOf(d)] = td; r[r.indexOf(td)] = d; g.lock = td.id; break;
      }
      case 'stir': {
        if (!isSecondTurn(g)) throw new Error('Only on your second turn of the round');
        needUnplaced(); commit(); g.pool.forEach((d) => { d.value = d6(); }); break;
      }
      case 'leadKnife': case 'file': {
        const d = p.window[a.from]; if (!d) throw new Error('Pick a die in your window to move');
        const w = [...p.window]; w[a.from] = null;
        const err = a.to === a.from ? 'Pick a different cell' : checkPlacement(w, pat, d, a.to, a.tool === 'leadKnife' ? { ignoreColor: true } : { ignoreValue: true });
        if (err) throw new Error(err);
        commit(); w[a.to] = d; p.window = w; break;
      }
      case 'loose': throw new Error('Loose Pane is used while placing a die');
      default: throw new Error('Unknown tool');
    }
    return;
  }
  if (a.type === 'pass') { endTurn(g); return; }
  throw new Error('Unknown action');
}

function endTurn(g) {
  const p = g.players[current(g)];
  if (!p.placed) log(g, `${p.name} passed.`);
  g.turn++; resetTurn(g);
  if (g.turn >= g.order.length) {
    g.track.push(g.pool); g.pool = [];
    if (g.round >= ROUNDS) return finish(g);
    beginRound(g, g.round + 1);
  }
}

function scorePlayer(g, p) {
  const w = p.window;
  const pub = g.objectives.map((id) => ({ id, pts: OBJECTIVES[id].score(w) }));
  const priv = w.filter((d) => d && d.color === p.secret).reduce((s, d) => s + d.value, 0);
  const empty = w.filter((d) => !d).length;
  const total = pub.reduce((s, x) => s + x.pts, 0) + priv + p.favor - empty;
  return { name: p.name, pub, priv, favor: p.favor, empty: -empty, total };
}

function finish(g) {
  g.phase = 'ended';
  g.results = g.players.map((p, i) => ({ i, ...scorePlayer(g, p) })).sort((a, b) => b.total - a.total || b.priv - a.priv || b.favor - a.favor);
  log(g, `Game over. ${g.results[0].name} wins with ${g.results[0].total}.`);
}

// What a given player is allowed to see.
function view(g, pi) {
  return {
    phase: g.phase, patternSet: g.patternSet || 'original', round: g.round, rounds: ROUNDS, turn: g.turn, order: g.order, current: g.phase === 'playing' ? current(g) : null,
    secondTurn: isSecondTurn(g), pool: g.pool, track: g.track, lock: g.lock, log: g.log.slice(-25), results: g.results, you: pi,
    objectives: g.objectives.map((id) => ({ id, name: OBJECTIVES[id].name, text: OBJECTIVES[id].text, pts: OBJECTIVES[id].pts })),
    tools: g.tools.map((t) => ({ ...t, name: TOOLS[t.id].name, text: TOOLS[t.id].text, cost: t.used ? 2 : 1 })),
    players: g.players.map((p, i) => ({
      name: p.name, connected: p.connected, window: p.window, favor: p.favor, placed: p.placed, toolUsed: p.toolUsed,
      pattern: p.pattern === null ? null : g.patterns[p.pattern], ready: p.pattern !== null,
      secret: i === pi || g.phase === 'ended' ? p.secret : null,
      choices: i === pi ? p.choices.map((id) => g.patterns[id]) : [],
    })),
  };
}

module.exports = { setCustomPatterns, validatePattern, newGameState, addPlayer, start, choosePattern, act, view, checkPlacement, PATTERNS, OBJECTIVES, TOOLS, COLORS };
