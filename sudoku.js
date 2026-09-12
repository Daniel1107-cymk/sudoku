'use strict';

// ---------- RNG ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Solver ----------
const PEERS = Array.from({ length: 81 }, (_, i) => {
  const r = Math.floor(i / 9), c = i % 9, br = r - r % 3, bc = c - c % 3, s = new Set();
  for (let k = 0; k < 9; k++) {
    s.add(r * 9 + k); s.add(k * 9 + c);
    s.add((br + Math.floor(k / 3)) * 9 + bc + k % 3);
  }
  s.delete(i);
  return [...s];
});

function candidates(grid, i) {
  const used = new Set();
  for (const p of PEERS[i]) if (grid[p]) used.add(grid[p]);
  const out = [];
  for (let d = 1; d <= 9; d++) if (!used.has(d)) out.push(d);
  return out;
}

// Counts solutions up to `limit`; leaves grid filled with the last found solution.
function solve(grid, rng, limit) {
  let best = -1, bestC = null;
  for (let i = 0; i < 81; i++) {
    if (grid[i]) continue;
    const c = candidates(grid, i);
    if (c.length === 0) return 0;
    if (bestC === null || c.length < bestC.length) { best = i; bestC = c; if (c.length === 1) break; }
  }
  if (best === -1) return 1;
  if (rng) shuffle(bestC, rng);
  let count = 0;
  for (const d of bestC) {
    grid[best] = d;
    count += solve(grid, rng, limit - count);
    if (count >= limit) return count;
  }
  grid[best] = 0;
  return count;
}

// ---------- Generator ----------
function generate(clues, rng) {
  const solution = new Array(81).fill(0);
  solve(solution, rng, 1);
  // ponytail: random single-pass removal stalls ~2-3 above target for expert; retry a few times, keep fewest clues
  let best = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const puzzle = solution.slice();
    let remaining = 81;
    for (const i of shuffle([...Array(81).keys()], rng)) {
      if (remaining <= clues) break;
      const saved = puzzle[i];
      puzzle[i] = 0;
      if (solve(puzzle.slice(), null, 2) !== 1) puzzle[i] = saved;
      else remaining--;
    }
    if (!best || remaining < best.filter(Boolean).length) best = puzzle;
    if (remaining <= clues) break;
  }
  return { puzzle: best, solution };
}

const CLUES = { easy: 40, medium: 32, hard: 26, expert: 22 };

// ---------- State ----------
const $ = (s) => document.querySelector(s);
let state, timer = null;

function newGame(difficulty, daily) {
  const seedStr = daily ? todayStr() : String(Math.random());
  const rng = mulberry32(hashStr(seedStr));
  const { puzzle, solution } = generate(CLUES[difficulty], rng);
  state = {
    puzzle, solution, difficulty, daily,
    number: hashStr(seedStr) % 9000 + 1000,
    cells: puzzle.map((v) => ({ value: v, notes: [] })),
    selected: null, notesMode: false, history: [], future: [],
    mistakes: 0, seconds: 0, paused: false, won: false, hint: null,
  };
  startTimer();
  render();
  save();
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function snapshot() { return JSON.stringify(state.cells); }
function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > 200) state.history.shift();
  state.future = [];
}

// ---------- Moves ----------
function setDigit(d) {
  const i = state.selected;
  if (i === null || state.puzzle[i] || state.paused || state.won) return;
  const cell = state.cells[i];
  state.hint = null;
  pushHistory();
  if (state.notesMode) {
    if (cell.value) cell.value = 0;
    const k = cell.notes.indexOf(d);
    k >= 0 ? cell.notes.splice(k, 1) : cell.notes.push(d);
  } else {
    if (cell.value === d) { cell.value = 0; }
    else {
      cell.value = d; cell.notes = [];
      if (d !== state.solution[i]) state.mistakes++;
      else for (const p of PEERS[i]) {
        const n = state.cells[p].notes, k = n.indexOf(d);
        if (k >= 0) n.splice(k, 1);
      }
    }
  }
  afterMove(i);
}

function erase() {
  const i = state.selected;
  if (i === null || state.puzzle[i] || state.paused || state.won) return;
  const cell = state.cells[i];
  if (!cell.value && !cell.notes.length) return;
  state.hint = null;
  pushHistory();
  cell.value = 0; cell.notes = [];
  afterMove();
}

// ---------- Hints ----------
const UNITS = [];
for (let k = 0; k < 9; k++) {
  UNITS.push({ name: 'row', cells: Array.from({ length: 9 }, (_, c) => k * 9 + c) });
  UNITS.push({ name: 'column', cells: Array.from({ length: 9 }, (_, r) => r * 9 + k) });
  const br = Math.floor(k / 3) * 3, bc = (k % 3) * 3;
  UNITS.push({ name: 'box', cells: Array.from({ length: 9 }, (_, j) => (br + Math.floor(j / 3)) * 9 + bc + j % 3) });
}
const rc = (i) => `row ${Math.floor(i / 9) + 1}, column ${i % 9 + 1}`;
const bold = (d) => `<b>${d}</b>`;

// ponytail: singles only (naked + hidden); harder positions fall back to revealing the answer
function findHint() {
  const grid = state.cells.map((c) => c.value);
  // 1. mistake first
  for (let i = 0; i < 81; i++) {
    if (!state.puzzle[i] && grid[i] && grid[i] !== state.solution[i]) {
      const clash = PEERS[i].find((p) => grid[p] === grid[i]);
      return { cell: i, digit: 0, kind: 'mistake', highlight: clash !== undefined ? [clash] : [],
        text: `The ${bold(grid[i])} in ${rc(i)} is wrong${clash !== undefined ? ` — there is already a ${bold(grid[i])} in ${rc(clash)}` : ''}. Erase it first.` };
    }
  }
  // 2. naked single
  for (let i = 0; i < 81; i++) {
    if (grid[i]) continue;
    const c = candidates(grid, i);
    if (c.length !== 1) continue;
    const seen = {};
    for (const p of PEERS[i]) if (grid[p] && !seen[grid[p]]) seen[grid[p]] = p;
    const used = Object.keys(seen).join(' ');
    return { cell: i, digit: c[0], kind: 'naked', highlight: Object.values(seen), cands: c,
      text: `Only ${bold(c[0])} fits in ${rc(i)}. Its row, column and box already contain ${used}, leaving just one choice.` };
  }
  // 3. hidden single
  for (const u of UNITS) {
    for (let d = 1; d <= 9; d++) {
      if (u.cells.some((i) => grid[i] === d)) continue;
      const spots = u.cells.filter((i) => !grid[i] && candidates(grid, i).includes(d));
      if (spots.length !== 1) continue;
      const i = spots[0], others = u.cells.filter((j) => !grid[j] && j !== i);
      return { cell: i, digit: d, kind: 'hidden', highlight: others, cands: candidates(grid, i),
        text: `${bold(d)} must go in ${rc(i)}. It is the only empty cell in this ${u.name} that can still take a ${d} — every other empty cell here already sees a ${d}.` };
    }
  }
  // 4. fallback
  const empty = grid.map((v, i) => v ? -1 : i).filter((i) => i >= 0);
  if (!empty.length) return null;
  const i = empty[Math.floor(Math.random() * empty.length)];
  return { cell: i, digit: state.solution[i], kind: 'reveal', highlight: [], cands: candidates(grid, i),
    text: `No single stands out right now — this needs a deeper technique (pairs, pointing, X-wing…). The answer for ${rc(i)} is ${bold(state.solution[i])}.` };
}

function hint() {
  if (state.paused || state.won) return;
  if (state.hint) {
    const h = state.hint, i = h.cell;
    state.hint = null;
    pushHistory();
    state.cells[i] = { value: h.digit, notes: [] };
    if (h.digit) for (const p of PEERS[i]) {
      const n = state.cells[p].notes, k = n.indexOf(h.digit);
      if (k >= 0) n.splice(k, 1);
    }
    state.selected = i;
    return afterMove(i);
  }
  state.hint = findHint();
  if (state.hint) state.selected = state.hint.cell;
  render();
}

function undo() {
  if (!state.history.length) return;
  state.hint = null;
  state.future.push(snapshot());
  state.cells = JSON.parse(state.history.pop());
  render(); save();
}
function redo() {
  if (!state.future.length) return;
  state.hint = null;
  state.history.push(snapshot());
  state.cells = JSON.parse(state.future.pop());
  render(); save();
}

function afterMove(popIndex) {
  if (state.cells.every((c, i) => c.value === state.solution[i])) {
    state.won = true; stopTimer();
  }
  render(popIndex);
  save();
}

// ---------- Timer ----------
function startTimer() {
  stopTimer();
  timer = setInterval(() => { state.seconds++; renderTime(); if (state.seconds % 10 === 0) save(); }, 1000);
}
function stopTimer() { clearInterval(timer); timer = null; }
function togglePause() {
  if (state.won) return;
  state.paused = !state.paused;
  state.paused ? stopTimer() : startTimer();
  render();
}
function fmtTime(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

// ---------- Persistence ----------
function save() { try { localStorage.setItem('sudoku', JSON.stringify(state)); } catch {} }
function load() {
  try {
    const s = JSON.parse(localStorage.getItem('sudoku'));
    if (s && s.cells && s.cells.length === 81) return s;
  } catch {}
  return null;
}

// ---------- Render ----------
const board = $('#board');
const cellEls = [];

function buildBoard() {
  for (let i = 0; i < 81; i++) {
    const b = document.createElement('button');
    b.className = 'cell';
    b.style.setProperty('--i', i);
    b.dataset.i = i;
    b.addEventListener('click', () => { state.selected = i; state.hint = null; render(); });
    board.appendChild(b);
    cellEls.push(b);
  }
}

function render(popIndex) {
  const sel = state.selected, selVal = sel !== null ? state.cells[sel].value : 0;
  const counts = new Array(10).fill(0);
  state.cells.forEach((c) => counts[c.value]++);

  cellEls.forEach((el, i) => {
    const c = state.cells[i], given = !!state.puzzle[i];
    const r = Math.floor(i / 9), col = i % 9;
    el.classList.toggle('given', given);
    el.classList.toggle('selected', i === sel);
    el.classList.toggle('related', sel !== null && i !== sel && PEERS[sel].includes(i));
    el.classList.toggle('same', !!selVal && c.value === selVal && i !== sel);
    el.classList.toggle('wrong', !!c.value && c.value !== state.solution[i]);
    el.classList.remove('pop');
    if (i === popIndex) { void el.offsetWidth; el.classList.add('pop'); }
    const h = state.hint;
    el.classList.toggle('hint-target', !!h && h.cell === i);
    el.classList.toggle('hint-peer', !!h && h.highlight.includes(i));
    const notes = h && h.cell === i && !c.value && h.cands ? h.cands : c.notes;
    if (c.value) el.textContent = c.value;
    else if (notes.length) {
      el.innerHTML = '<span class="notes">' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<i>${notes.includes(d) ? d : ''}</i>`).join('') + '</span>';
    } else el.textContent = '';
    el.setAttribute('aria-label', `row ${r + 1} column ${col + 1}${c.value ? ', ' + c.value : c.notes.length ? ', notes ' + c.notes.join(' ') : ', empty'}${given ? ', given' : ''}`);
    el.setAttribute('aria-pressed', i === sel);
  });

  document.querySelectorAll('.pad button[data-d]').forEach((b) => {
    const d = +b.dataset.d, left = 9 - counts[d];
    b.querySelector('small').textContent = left > 0 ? left : '';
    b.disabled = left <= 0;
  });
  $('#notes').setAttribute('aria-pressed', state.notesMode);
  $('#undo').disabled = !state.history.length;
  $('#redo').disabled = !state.future.length;
  $('#mistakes').textContent = state.mistakes;
  $('#hint').textContent = state.hint ? (state.hint.digit ? 'Fill it in' : 'Erase it') : 'Hint';
  $('#hint-text').hidden = !state.hint;
  $('#hint-text').innerHTML = state.hint ? state.hint.text : '';
  $('#pause').textContent = state.paused ? 'Resume' : 'Pause';
  $('#difficulty').value = state.difficulty;
  $('#folio').textContent = `No. ${state.number.toLocaleString()} · ${state.daily ? 'Daily · ' : ''}${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${state.difficulty[0].toUpperCase() + state.difficulty.slice(1)}`;
  document.body.classList.toggle('paused', state.paused);
  document.body.classList.toggle('won', state.won);
  if (state.won) {
    $('#win-time').textContent = fmtTime(state.seconds);
    $('#win-mistakes').textContent = state.mistakes;
  }
  renderTime();
}
function renderTime() { $('#time').textContent = fmtTime(state.seconds); }

// ---------- Input ----------
function bind() {
  document.querySelectorAll('.pad button[data-d]').forEach((b) => b.addEventListener('click', () => setDigit(+b.dataset.d)));
  $('#erase').addEventListener('click', erase);
  $('#notes').addEventListener('click', () => { state.notesMode = !state.notesMode; render(); });
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#hint').addEventListener('click', hint);
  $('#pause').addEventListener('click', togglePause);
  $('#new').addEventListener('click', () => newGame($('#difficulty').value, false));
  $('#daily').addEventListener('click', () => newGame('medium', true));
  $('#win-new').addEventListener('click', () => newGame(state.difficulty, false));
  $('#difficulty').addEventListener('change', (e) => newGame(e.target.value, false));

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.key >= '1' && e.key <= '9') return setDigit(+e.key);
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') return erase();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey) { state.notesMode = !state.notesMode; return render(); }
    if (e.key.toLowerCase() === 'h') return hint();
    if (e.key.toLowerCase() === 'p' || e.key === 'Escape') return togglePause();
    const dr = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (dr !== undefined) {
      e.preventDefault();
      const i = state.selected === null ? 0 : (state.selected + dr + 81) % 81;
      state.selected = i; render(); cellEls[i].focus();
    }
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden && !state.paused && !state.won) togglePause(); });
}

// ---------- Boot ----------
function boot() {
  buildBoard();
  bind();
  const saved = load();
  if (saved) {
    state = saved;
    if (!state.paused && !state.won) startTimer();
    render();
  } else newGame('medium', false);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#install').hidden = false; });
  $('#install').addEventListener('click', () => { installEvt && installEvt.prompt(); $('#install').hidden = true; });
}

// ---------- Self-test (open with #test) ----------
function selfTest() {
  const t0 = performance.now();
  for (const [name, n] of Object.entries(CLUES)) {
    const { puzzle, solution } = generate(n, mulberry32(hashStr('test-' + name)));
    const count = puzzle.filter(Boolean).length;
    console.assert(count >= n && count <= n + 2, name + ': clue count ' + count);
    console.assert(solve(puzzle.slice(), null, 2) === 1, name + ': unique');
    const g = puzzle.slice(); solve(g, null, 1);
    console.assert(g.join('') === solution.join(''), name + ': solves to solution');
  }
  // hints: every hint on fresh puzzles must agree with the solution
  const savedState = state;
  for (let k = 0; k < 20; k++) {
    const g = generate(k < 10 ? 40 : 22, mulberry32(k));
    state = { puzzle: g.puzzle, solution: g.solution, cells: g.puzzle.map((v) => ({ value: v, notes: [] })) };
    const h = findHint();
    console.assert(h && h.digit === g.solution[h.cell], 'hint digit matches solution #' + k);
    console.assert(h.kind === 'reveal' || h.text.includes('<b>' + h.digit + '</b>'), 'hint text names digit #' + k);
    if (k < 10) console.assert(h.kind !== 'reveal', 'easy puzzle has a single #' + k);
    state.cells[h.cell].value = h.digit === 1 ? 2 : 1; // plant a mistake
    console.assert(findHint().kind === 'mistake', 'mistake detected #' + k);
  }
  state = savedState;
  const a = generate(32, mulberry32(hashStr('2026-09-12'))).puzzle.join('');
  const b = generate(32, mulberry32(hashStr('2026-09-12'))).puzzle.join('');
  console.assert(a === b, 'daily deterministic');
  console.log('selfTest done in', Math.round(performance.now() - t0), 'ms');
}

if (location.hash === '#test') selfTest();
boot();
