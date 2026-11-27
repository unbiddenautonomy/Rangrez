// Computer players. Each bot looks at the full game state and returns the actions for its turn.
//   easy   - places a random legal die, never uses tools
//   medium - protects restricted cells, likes its secret color
//   hard   - also plays toward the public objectives and uses Chisel / Turn the Glass / Recast when it helps
const { checkPlacement } = require('./game');

const COLS = 5, ROWS = 4;
const orth = (i) => { const r = Math.floor(i / COLS), c = i % COLS; return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => [r + a, c + b]).filter(([x, y]) => x >= 0 && x < ROWS && y >= 0 && y < COLS).map(([x, y]) => x * COLS + y); };
const req = (pat, i) => { const ch = pat.rows[Math.floor(i / COLS)][i % COLS]; return ch === '.' ? null : ch; };
const NAMES = ['Meera', 'Kabir', 'Tara', 'Arjun', 'Zoya', 'Dev', 'Ira', 'Vikram'];
const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

function botName(existing, level) {
  const used = new Set(existing);
  const n = NAMES.find((x) => ![...used].some((u) => u.startsWith(x))) || 'Bot';
  return `${n} (${LEVEL_LABEL[level]})`;
}

function choosePattern(g, pi, level) {
  const choices = g.players[pi].choices.map((id) => g.patterns[id]);
  if (level === 'easy') return choices[Math.floor(Math.random() * choices.length)].id;
  // Medium plays it safe; hard takes more favor for tools.
  const want = level === 'hard' ? [5, 4, 6, 3] : [4, 3, 5, 6];
  for (const d of want) { const p = choices.find((x) => x.difficulty === d); if (p) return p.id; }
  return choices[0].id;
}

// How many empty cells could no longer take any die at all (restriction + neighbours)?
const COLORS = ['R', 'Y', 'G', 'B', 'P'];
function deadCells(w, pat) {
  let dead = 0;
  for (let j = 0; j < 20; j++) {
    if (w[j]) continue;
    const q = req(pat, j), nb = orth(j).map((k) => w[k]).filter(Boolean);
    const cs = q && COLORS.includes(q) ? [q] : COLORS, vs = q && /[1-6]/.test(q) ? [+q] : [1, 2, 3, 4, 5, 6];
    const ok = cs.some((c) => !nb.some((x) => x.color === c)) && vs.some((v) => !nb.some((x) => x.value === v));
    if (!ok) dead++;
  }
  return dead;
}

// Score placing die d on cell i for this player. Higher is better.
function score(g, p, pat, d, i, level) {
  const w = p.window;
  let s = Math.random() * (level === 'hard' ? 0.4 : 2.5); // medium is sloppier
  if (req(pat, i)) s += level === 'hard' ? 3 : 2; // fill restricted cells while you can
  for (const j of orth(i)) {
    if (w[j]) continue;
    const q = req(pat, j);
    if (q && (q === d.color || q === String(d.value))) s -= 3; // would make a neighbour impossible
    else s -= 0.25;
  }
  if (d.color === p.secret) s += d.value * (level === 'hard' ? 0.6 : 0.35);
  if (level === 'hard') {
    const before = deadCells(w, pat); w[i] = d; const after = deadCells(w, pat); w[i] = null;
    s -= 4 * (after - before);
    // Prefer dice of awkward values/colors for restricted cells now; open cells can wait.
    if (!req(pat, i) && g.round < 6) s -= 0.6;
    const r = Math.floor(i / COLS), c = i % COLS;
    const row = [...Array(COLS)].map((_, k) => w[r * COLS + k]).filter(Boolean);
    const col = [...Array(ROWS)].map((_, k) => w[k * COLS + c]).filter(Boolean);
    for (const o of g.objectives) {
      if (o === 'prismRows' && row.some((x) => x.color === d.color)) s -= 1.5;
      if (o === 'prismCols' && col.some((x) => x.color === d.color)) s -= 1.5;
      if (o === 'numRows' && row.some((x) => x.value === d.value)) s -= 1.5;
      if (o === 'numCols' && col.some((x) => x.value === d.value)) s -= 1.5;
      if (o === 'highPair' && d.value >= 5) s += 0.7;
      if (o === 'lowPair' && d.value <= 2) s += 0.7;
      if (o === 'midPair' && (d.value === 3 || d.value === 4)) s += 0.7;
    }
  }
  return s;
}

function bestPlacement(g, p, pat, dice, level) {
  let best = null;
  for (const d of dice) for (let i = 0; i < 20; i++) {
    if (checkPlacement(p.window, pat, d, i)) continue;
    const s = level === 'easy' ? Math.random() : score(g, p, pat, d, i, level);
    if (!best || s > best.s) best = { s, d, i };
  }
  return best;
}

// Returns a list of actions to perform in order this turn (the server ends the turn after them).
function planTurn(g, pi, level) {
  const p = g.players[pi], pat = g.patterns[p.pattern];
  const pool = g.lock ? g.pool.filter((d) => d.id === g.lock) : g.pool;
  const best = bestPlacement(g, p, pat, pool, level);
  const actions = [];

  if (level === 'hard' && !p.toolUsed) {
    // Try die-changing tools: is there a version of a pool die that scores clearly better?
    const tryTools = [];
    for (const t of g.tools) {
      const cost = t.used ? 2 : 1;
      if (p.favor < cost || (p.favor - cost < 1 && g.round < 8)) continue; // keep a token in reserve early
      for (const d of g.pool) {
        if (t.id === 'chisel') { for (const dir of [1, -1]) { const v = d.value + dir; if (v >= 1 && v <= 6) tryTools.push({ tool: t.id, d, dir, nd: { ...d, value: v } }); } }
        if (t.id === 'flip') tryTools.push({ tool: t.id, d, nd: { ...d, value: 7 - d.value } });
      }
    }
    let improve = null;
    for (const x of tryTools) {
      const b = bestPlacement(g, p, pat, [x.nd], level);
      if (b && (!best || b.s > best.s + 2.5) && (!improve || b.s > improve.s)) improve = { ...x, s: b.s };
    }
    if (improve) {
      actions.push({ type: 'tool', tool: improve.tool, dieId: improve.d.id, dir: improve.dir || 0 });
      actions.push({ type: 'placeBest' }); // re-plan placement after the die changes
      return actions;
    }
  }

  if (best && !(level === 'easy' && Math.random() < 0.15)) actions.push({ type: 'place', dieId: best.d.id, cell: best.i });
  return actions;
}

module.exports = { planTurn, choosePattern, bestPlacement, botName };
