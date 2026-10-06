/* =============================================================
   PENTERACTION - SLICED REALITY
   Canvas2D. A nestable 5D lattice you slice one plane at a time.

   CONTROLS
     W / S   plane axis B  -1 / +1     Space   depth axis +1
     A / D   plane axis A  -1 / +1     Shift   depth axis -1 (on its own)
     X       cycle depth axis           Tab     cycle plane pair
     R       cycle signature (color)   V       colorblind patterns
     M       fullscreen lattice map    N       hide/show minimap
     C       reset the camera          [ ]     scroll the map
     , .     minimap dot size          + -     map zoom
     drag    orbit the camera          0       reset map zoom
     wheel   game-view zoom
   ============================================================= */
(() => {
  'use strict';

  /* ---------------------------------------------------------
     0. CONSTANTS
     --------------------------------------------------------- */
  const AXIS_NAME = ['X', 'Y', 'Z', 'W', 'V'];
  const AXIS_POS = ['East', 'South', 'Up', 'Ana', 'Exo'];
  const AXIS_NEG = ['West', 'North', 'Down', 'Kata', 'Endo'];
  const PLANE_PAIRS = [[0,1],[0,2],[0,3],[0,4],[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]];

  // The lattice is drawn through an orthographic camera. YAW spins it around the
  // depth axis, PITCH tips it out of isometric: at 30 deg you get the classic
  // isometric, near 85 deg you look straight down onto the plane, near 0 deg you
  // get a side elevation of the slice stack. The two scales below reproduce the
  // original fixed isometric exactly at yaw 45 / pitch 30.
  const YAW0 = Math.PI / 4, PITCH0 = Math.PI / 6;
  const CAM_SP = 50.9, CAM_SD = 39.3;        // screen length of one cell, plane / depth
  // pitch stays 24 deg - 85 deg off the plane. flatter than that and the tiles
  // squash into unreadable slivers, so the drag stops short of edge-on.
  const PITCH_MIN = 0.42, PITCH_MAX = 1.4835;
  const TILE_HW = 36, TILE_HH = 18;         // default tile half-size, used for glyphs only
  const YAW_DRAG = 0.0075, PITCH_DRAG = 0.0075;

  // the three projected unit vectors that matter: the two plane axes and depth
  let BAS = { ax: { x: TILE_HW, y: TILE_HH }, ay: { x: -TILE_HW, y: TILE_HH }, az: { x: 0, y: -2 * TILE_HH } };
  let CORN = [];                            // tile corners, rebuilt with the basis
  // How far the lattice is scaled down to fit the window. Room SIZE is drawn with
  // this factor, so room SPACING has to use it too, or every room is drawn smaller
  // than the distance to its neighbor and the background shows through the joins.
  // Set once per frame in draw(), before anything asks cellScreen() for a center.
  let FIT = 1;


  const PALETTE = [
    { name: 'CYAN',    hex: '#35e0ff', glyph: '◆' },
    { name: 'MAGENTA', hex: '#ff4fd8', glyph: '▲' },
    { name: 'AMBER',   hex: '#ffb03a', glyph: '■' },
    { name: 'LIME',    hex: '#8cff5a', glyph: '●' },
    { name: 'VIOLET',  hex: '#9d6bff', glyph: '▼' },
  ];

  // links are keyed by axis AND direction so a cell keeps both +axis and -axis
  const LK = (axis, dir) => axis * 2 + (dir > 0 ? 1 : 0);

  const KIND = { OPEN: 0, DOOR: 1, LADDER: 2, GATE: 3, LOCK: 4 };

  const MAX_CELLS = 60000;      // room budget for one lattice
  const WINS_TO_UNLOCK = 3;     // wins per mode before the big lattices open
  const SIZE_SMALL = 5, SIZE_BIG = 25;
  // every axis must be at least 2 deep. a 1-deep axis has no interior, so the
  // lattice would be one single room with nothing to explore
  const MIN_AXIS = 2;

  /* ---------------------------------------------------------
     1. CANVAS
     --------------------------------------------------------- */
  const cvs = document.getElementById('stage');
  const ctx = cvs.getContext('2d', { alpha: false });
  const mini = document.getElementById('minimap');
  const mctx = mini.getContext('2d');
  const full = document.getElementById('fullmap-canvas');
  const fctx = full.getContext('2d');
  const toastEl = document.getElementById('toast');

  let W = 0, H = 0, DPR = 1, CX = 0, CY = 0, ZOOM = 1;

  function sizeFullMap() {
    full.width = Math.max(1, Math.floor(W * DPR));
    full.height = Math.max(1, Math.floor(H * DPR));
    fctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cvs.width = Math.floor(W * DPR); cvs.height = Math.floor(H * DPR);
    cvs.style.width = W + 'px'; cvs.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    CX = W * 0.5;
    CY = H * 0.52;
    ZOOM = Math.max(0.9, Math.min(2.0, Math.min(W / 1300, H / 780) * 1.9));
    sizeFullMap();
    G.mapDirty = true; G.rev++;
  }
  window.addEventListener('resize', resize);

  /* ---------------------------------------------------------
     2. CONFIG + PROGRESS
     --------------------------------------------------------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  const CFG = {
    mode: 'regular',                 // 'regular' | 'lockdown'
    dims: [4, 4, 2, 2, 2],
    renderDist: 3,
    gateColors: 3,                    // how many signature colors the gates use
  };

  const PROGRESS = { regularWins: 0, lockdownWins: 0 };

  function loadProgress() {
    try {
      const raw = JSON.parse(store.get('penteraction.progress') || 'null');
      if (raw) {
        PROGRESS.regularWins = raw.regularWins | 0;
        PROGRESS.lockdownWins = raw.lockdownWins | 0;
      }
    } catch (e) { /* fresh start */ }
  }
  function saveProgress() {
    store.set('penteraction.progress', JSON.stringify(PROGRESS));
  }
  const bigUnlocked = () => PROGRESS.regularWins >= WINS_TO_UNLOCK && PROGRESS.lockdownWins >= WINS_TO_UNLOCK;
  const maxAxis = () => (bigUnlocked() ? SIZE_BIG : SIZE_SMALL);

  // keep the room count inside the budget by trimming the depth axes
  function fitDims(dims) {
    const d = dims.slice();
    const total = () => d.reduce((a, b) => a * b, 1);
    let trimmed = false;
    for (let a = 4; a >= 2 && total() > MAX_CELLS; a--) {
      while (total() > MAX_CELLS && d[a] > 1) { d[a]--; trimmed = true; }
    }
    return { dims: d, trimmed, cells: total() };
  }

  /* ---------------------------------------------------------
     3. LATTICE STATE
     --------------------------------------------------------- */
  let DIMS = [4, 4, 2, 2, 2];
  let SIZE = 0;

  const G = {
    links: null,        // links[i] = Map<LK(axis,dir), link>
    pads: null,         // pads[i]  = signature color index or -1
    keyAt: null,        // keyAt[i] = key color index or -1
    keyGone: null,      // keyGone[i] = picked up already
    visited: null,
    sensed: null,
    exit: 0,
    player: null,
    planeIx: 0,
    color: 0,
    points: 0,
    keys: [],           // key colors held
    unlocked: new Set(),
    history: [],
    time: 0,
    done: false,
    colorblind: false,
    showMap: true,
    fullMap: false,
    mapPage: 0,         // which V slice the map is showing
    mapZoom: 1,         // map zoom (minimap + fullscreen), driven by + and -
    playerScale: 1,     // player dot size on the maps, independent of map zoom
    viewZoom: 1,        // main-view zoom, driven by the mouse wheel
    yaw: YAW0, pitch: PITCH0,       // live camera
    yawT: YAW0, pitchT: PITCH0,     // where the drag is pulling it

    mapDirty: true,
    rev: 0,             // bumped whenever the map contents change
    blockedDepth: [],   // depth directions you cannot step from your own room
    locks: 0,
  };

  const idxOf = c => c[0] + DIMS[0] * (c[1] + DIMS[1] * (c[2] + DIMS[2] * (c[3] + DIMS[3] * c[4])));
  const coordOf = i => [
    i % DIMS[0],
    Math.floor(i / DIMS[0]) % DIMS[1],
    Math.floor(i / (DIMS[0] * DIMS[1])) % DIMS[2],
    Math.floor(i / (DIMS[0] * DIMS[1] * DIMS[2])) % DIMS[3],
    Math.floor(i / (DIMS[0] * DIMS[1] * DIMS[2] * DIMS[3])),
  ];
  const inBounds = c => c.every((v, a) => v >= 0 && v < DIMS[a]);

  const planeAxes = () => PLANE_PAIRS[G.planeIx];
  const freeAxes = () => [0, 1, 2, 3, 4].filter(a => !planeAxes().includes(a));
  // the depth axis is a real choice the player cycles with R - honor it
  function depthAxis() {
    const free = freeAxes();
    return free.includes(G.depthAx) ? G.depthAx : free[0];
  }
  const depthAxisVal = () => G.player.c[depthAxis()];
  const curIdx = () => idxOf(G.player.c);

  // Toasts belong to the page you are looking at. The element is shared, so it
  // is hidden whenever the main menu is up, and any toast still fading out is
  // cancelled when the page changes - otherwise a message raised on one page
  // carries over and shows up on all of them.
  function pageUp() {
    return $('overlay').classList.contains('show') || $('win').classList.contains('show');
  }
  function hideToast() {
    clearTimeout(toast._t);
    toastEl.className = '';
    toastEl.textContent = '';
  }
  // keeps the canvas/HUD hidden and the toast suppressed for as long as a menu
  // is on screen, no matter which code path opened or closed it
  function syncToastPage() {
    const up = pageUp();
    document.body.classList.toggle('menu-up', up);
    toastEl.classList.toggle('suppressed', up);
  }
  function toast(msg, kind) {
    if (pageUp()) return;
    clearTimeout(toast._t);
    toastEl.textContent = msg;
    toastEl.className = 'show ' + (kind || '');
    toast._t = setTimeout(() => (toastEl.className = ''), 1600);
  }

  /* ---------------------------------------------------------
     4. GENERATION
     --------------------------------------------------------- */
  function generate(seed) {
    let s = seed >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;

    const fit = fitDims(CFG.dims);
    DIMS = fit.dims;
    SIZE = DIMS.reduce((a, b) => a * b, 1);
    G.trimmed = fit.trimmed;

    G.links = Array.from({ length: SIZE }, () => new Map());
    G.pads = new Array(SIZE).fill(-1);
    G.keyAt = new Array(SIZE).fill(-1);
    G.keyGone = new Uint8Array(SIZE);
    G.visited = new Uint8Array(SIZE);
    G.sensed = new Uint8Array(SIZE);

    // ---- randomised DFS spanning tree: every passage two-way ----
    const start = coordOf(0);
    const seen = new Uint8Array(SIZE);
    const stack = [start];
    seen[0] = 1;
    while (stack.length) {
      const cur = stack[stack.length - 1];
      const opts = [];
      for (let a = 0; a < 5; a++) {
        const nxt = cur.slice(); nxt[a]++;
        if (inBounds(nxt) && !seen[idxOf(nxt)]) opts.push([a, nxt]);
      }
      if (!opts.length) { stack.pop(); continue; }
      const [a, nxt] = opts[Math.floor(rnd() * opts.length)];
      const ni = idxOf(nxt);
      const ci = idxOf(cur);
      seen[ni] = 1;
      G.links[ci].set(LK(a, +1), { to: ni, kind: KIND.OPEN, color: -1, locked: false, tuned: false });
      G.links[ni].set(LK(a, -1), { to: ci, kind: KIND.OPEN, color: -1, locked: false, tuned: false });
      stack.push(nxt);
    }

    // ---- signature gates: more of them, in the colors the player chose ----
    const order = [];
    for (let i = 0; i < SIZE; i++) order.push(i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // 0 gate colors means the lattice is left completely open
    const gateCols = clamp(CFG.gateColors | 0, 0, PALETTE.length);
    if (gateCols > 0) {
      // links on the lattice skin are skipped below, so start generous to keep
      // plenty of doors in the finished lattice
      const gateRate = CFG.mode === 'lockdown' ? 0.34 : 0.62;
      for (const i of order) {
        for (const [lk, link] of G.links[i]) {
          if (link.to < i) continue;
          if (rnd() > gateRate) continue;
          const ax = lk >> 1, dir = (lk & 1) ? +1 : -1;
          // never on the lattice skin: a door whose passage runs along an outer
          // face would be flush with the edge, so leave that passage plain
          if (linkOnSkin(coordOf(i), coordOf(link.to), ax)) continue;
          const kind = ax === 2 ? KIND.LADDER : ax <= 1 ? KIND.DOOR : KIND.GATE;
          const ci = Math.floor(rnd() * gateCols);
          const fwd = G.links[i].get(LK(ax, dir));
          const back = G.links[link.to].get(LK(ax, -dir));
          if (fwd) { fwd.kind = kind; fwd.color = ci; fwd.locked = true; }
          if (back) { back.kind = kind; back.color = ci; back.locked = true; }
        }
      }
    }

    // ---- exit: farthest room from the start ----
    const dist = new Int32Array(SIZE).fill(-1);
    const parent = new Int32Array(SIZE).fill(-1);
    dist[0] = 0; parent[0] = 0;
    const bq = [0];
    while (bq.length) {
      const i = bq.shift();
      for (const [, l] of G.links[i]) {
        if (dist[l.to] >= 0) continue;
        dist[l.to] = dist[i] + 1; parent[l.to] = i; bq.push(l.to);
      }
    }
    let far = 0, fd = -1;
    for (let i = 0; i < SIZE; i++) if (dist[i] > fd) { fd = dist[i]; far = i; }
    G.exit = far;
    G.exitDist = fd;

    // ---- lockdown: locks and the keys that open them ----
    G.locks = 0;
    if (CFG.mode === 'lockdown') placeLocks(rnd, parent);

    // ---- signature pads: one per gate color, so the pad count always matches
    //      the number of door colors, never on the exit ----
    for (let c = 0; c < PALETTE.length; c++) G.pads[order[(c * 7 + 3) % SIZE]] = -1;
    const padCols = clamp(CFG.gateColors | 0, 0, PALETTE.length);
    if (padCols > 0) {
      const inner = order.filter(i => !roomOnSkin(coordOf(i)) && i !== G.exit);
      for (let c = 0; c < padCols; c++) {
        const room = inner.length ? inner[(c * 7 + 3) % inner.length] : order[c % SIZE];
        if (room !== G.exit && G.pads[room] < 0) G.pads[room] = c;
      }
      G.pads[0] = 0;
    }
    if (G.pads[G.exit] >= 0) G.pads[G.exit] = -1;
    if (G.keyAt[G.exit] >= 0) G.keyAt[G.exit] = -1;

    // ---- fresh run ----
    G.player = { c: coordOf(0), f: [0, 0, 0, 0, 0] };
    G.planeIx = 0;
    G.color = 0;
    G.points = 0;
    G.keys = [];
    G.unlocked = new Set();
    G.history = [];
    G.time = 0;
    G.done = false;
    G.visited[0] = 1;
    G.mapPage = 0;
    G.mapDirty = true; G.rev++;
    refreshSensed();
  }

  /*
    Lockdown rules:
      - a lock needs a key of its color (signature gates still need your color)
      - every key sits on the root side of its own lock, so it can always be
        picked up without passing the lock it opens
      - keys live on the spine (root -> exit) in order, so the run can never
        deadlock: each key is reached before the lock that needs it
  */
  function placeLocks(rnd, parent) {
    // spine: the real root -> exit path, via tree parents
    const spine = [];
    for (let c = G.exit; c !== 0; c = parent[c]) {
      spine.push(c);
      if (spine.length > SIZE) break;
    }
    spine.push(0);
    spine.reverse();
    const L = spine.length;
    if (L < 5) return;                       // too small for locks
    const onSpine = new Set(spine);

    const used = new Set();
    // lock colors come from the same palette the gates use, so the signature
    // pads on offer always cover every locked color too. with 0 gate colors
    // there are no pads at all, so lockdown falls back to the whole palette.
    const gateCols = clamp(CFG.gateColors | 0, 0, PALETTE.length) || PALETTE.length;
    const freeColor = () => {
      for (let t = 0; t < 12; t++) {
        const c = Math.floor(rnd() * gateCols);
        if (!used.has(c)) { used.add(c); return c; }
      }
      return -1;
    };
    // a lock only goes where its passage is not flush with the lattice skin
    const lockable = (a, b) => {
      const ca = coordOf(a), cb = coordOf(b);
      let ax = -1;
      for (let k = 0; k < 5; k++) if (ca[k] !== cb[k]) { ax = k; break; }
      return !linkOnSkin(ca, cb, ax);
    };
    // earliest free spine room in [lo, hi] - always on the root side of any
    // lock placed further along, so the key can never be behind its own lock
    const keyCell = (lo, hi, avoidA, avoidB) => {
      for (let j = Math.max(1, lo); j <= Math.min(hi, L - 2); j++) {
        const cell = spine[j];
        if (cell === avoidA || cell === avoidB) continue;
        if (G.keyAt[cell] >= 0) continue;
        return cell;
      }
      return -1;
    };

    // --- locks along the spine, each with its key before it ---
    // Collect every spine slot whose passage is clear of the skin, then spread
    // the locks evenly through those. Sampling a few ideal slots instead would
    // quietly drop locks whenever the ideal ones happened to sit on the edge.
    const slots = [];
    for (let k = 3; k <= L - 2; k++) if (lockable(spine[k - 1], spine[k])) slots.push(k);
    const nSpine = Math.max(1, Math.min(6, Math.floor(L / 4), slots.length));
    let prev = 1;
    for (let n = 0; n < nSpine; n++) {
      // the nth usable slot, spread evenly, but never behind the last lock
      const want = slots[Math.floor((n + 0.5) * slots.length / nSpine)];
      let at = -1;
      for (let t = 0; t < slots.length; t++) {
        const cand = slots[(Math.floor((n + 0.5) * slots.length / nSpine) + t) % slots.length];
        if (cand > prev + 1) { at = cand; break; }
      }
      if (at < 0) at = Math.max(...slots.filter(k => k > prev + 1));
      if (!(at > prev + 1)) break;
      const ci = freeColor();
      if (ci < 0) break;
      const a = spine[at - 1], b = spine[at];
      const kc = keyCell(1, at - 1, a, b);
      if (kc < 0) break;
      G.keyAt[kc] = ci;
      lockEdge(a, b, ci);
      prev = at;
    }

    // --- branch locks hanging off spine rooms; their key sits on the spine ---
    const want = Math.min(nSpine + 2, 6);
    let placed = 0, guard = 0;
    while (placed < want && guard++ < 6000) {
      const si = 1 + Math.floor(rnd() * (L - 2));
      const a = spine[si];
      const axes = [];
      for (let ax = 0; ax < 5; ax++) {
        for (const dir of [+1, -1]) {
          const l = G.links[a].get(LK(ax, dir));
          if (l && l.kind === KIND.OPEN && !onSpine.has(l.to) && lockable(a, l.to)) axes.push(l.to);
        }
      }
      if (!axes.length) continue;
      const b = axes[Math.floor(rnd() * axes.length)];
      const ci = freeColor();
      if (ci < 0) break;
      const kc = keyCell(1, si, a, b);
      if (kc < 0) continue;
      G.keyAt[kc] = ci;
      lockEdge(a, b, ci);
      placed++;
    }
  }

  // A door sits "on the edge of the lattice" when the passage it fills runs
  // ALONG an outer face: the two rooms share a boundary coordinate on some axis
  // other than the one they differ on. Those doors would be flush with the skin,
  // so they are never generated. Only axes 4 or deeper count - a 2 or 3 deep
  // axis has no real interior, and excluding it would strip the lattice bare.
  function linkOnSkin(ca, cb, ax) {
    for (let b = 0; b < 5; b++) {
      if (b === ax) continue;
      if (DIMS[b] < 4) continue;
      if (ca[b] !== cb[b]) continue;             // the passage crosses this axis
      if (ca[b] === 0 || ca[b] === DIMS[b] - 1) return true;
    }
    return false;
  }

  function roomOnSkin(c) { return linkOnSkin(c, c, -1); }

  // place a lock unless its passage would sit on the lattice skin
  function lockEdge(a, b, ci) {
    const ca = coordOf(a), cb = coordOf(b);
    let ax = -1;
    for (let k = 0; k < 5; k++) if (ca[k] !== cb[k]) { ax = k; break; }
    if (linkOnSkin(ca, cb, ax)) return false;
    for (const [x, y] of [[a, b], [b, a]]) {
      const c = coordOf(x);
      for (let k = 0; k < 5; k++) {
        const nb = c.slice(); nb[k] += 1;
        if (!inBounds(nb) || idxOf(nb) !== y) continue;
        const l = G.links[x].get(LK(k, +1));
        if (l) { l.kind = KIND.LOCK; l.color = ci; l.locked = true; }
      }
    }
    G.locks++;
    return true;
  }

  // hollow = sensed through a wall (cached: recomputed only when discovery changes).
  // Only the rooms directly next to somewhere you have stood. Following whole
  // open passages instead charted dozens of hollow rooms across every slice and
  // buried the ones you had actually found.
  function refreshSensed() {
    if (!G.sensed || G.sensed.length !== SIZE) G.sensed = new Uint8Array(SIZE);
    G.sensed.fill(0);
    for (let i = 0; i < SIZE; i++) {
      if (!G.visited[i]) continue;
      const c = coordOf(i);
      for (let a = 0; a < 5; a++) {
        for (const dir of [1, -1]) {
          const n = c.slice(); n[a] += dir;
          if (inBounds(n)) G.sensed[idxOf(n)] = 1;
        }
      }
    }
    G.mapDirty = true; G.rev++;
  }

  /* ---------------------------------------------------------
     5. AUDIO
     --------------------------------------------------------- */
  const Audio_ = { ctx: null, master: null };

  function audioInit() {
    if (Audio_.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    Audio_.ctx = new AC();
    Audio_.master = Audio_.ctx.createGain();
    Audio_.master.gain.value = 0;
    Audio_.master.connect(Audio_.ctx.destination);
    [55, 82.5, 110].forEach((f, k) => {
      const o = Audio_.ctx.createOscillator(), g = Audio_.ctx.createGain();
      const lfo = Audio_.ctx.createOscillator(), lg = Audio_.ctx.createGain();
      o.type = k === 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      g.gain.value = 0.16 / (k + 1);
      lfo.frequency.value = 0.05 + k * 0.037;
      lg.gain.value = 0.08;
      lfo.connect(lg); lg.connect(g.gain);
      o.connect(g); g.connect(Audio_.master);
      o.start(); lfo.start();
    });
    Audio_.master.gain.linearRampToValueAtTime(0.5, Audio_.ctx.currentTime + 3);
  }

  function blip(freq, dur, type, vol) {
    if (!Audio_.ctx) return;
    const t = Audio_.ctx.currentTime;
    const o = Audio_.ctx.createOscillator(), g = Audio_.ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol == null ? 0.16 : vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(Audio_.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  const sfx = {
    step:  () => blip(320, 0.1, 'triangle', 0.05),
    lock:  () => { blip(150, 0.16, 'sawtooth', 0.07); setTimeout(() => blip(118, 0.18, 'sawtooth', 0.06), 70); },
    match: () => { blip(660, 0.22, 'sine', 0.11); setTimeout(() => blip(990, 0.3, 'sine', 0.08), 80); },
    key:   () => { [784, 1047, 1319].forEach((f, k) => setTimeout(() => blip(f, 0.26, 'sine', 0.09), k * 70)); },
    axis:  () => { blip(240, 0.28, 'sine', 0.1); setTimeout(() => blip(480, 0.36, 'sine', 0.07), 110); },
    color: () => { blip(420, 0.18, 'triangle', 0.09); setTimeout(() => blip(630, 0.24, 'triangle', 0.06), 90); },
    win:   () => [523, 659, 784, 1047].forEach((f, k) => setTimeout(() => blip(f, 0.7, 'sine', 0.12), k * 150)),
  };

  /* ---------------------------------------------------------
     6. MOVEMENT / RULES
     --------------------------------------------------------- */
  function tryMove(axis, dir) {
    if (G.done) return;
    const from = G.player.c.slice();
    const to = from.slice();
    to[axis] += dir;
    if (!inBounds(to)) { bump(axis, dir); return; }

    const link = G.links[idxOf(from)].get(LK(axis, dir));
    if (!link || link.to !== idxOf(to)) {
      sfx.lock();
      toast(`${AXIS_NAME[axis]}${dir > 0 ? '+' : '-'} · SOLID LATTICE`, 'bad');
      bump(axis, dir);
      return;
    }

    // locks: need a key of their color (and are opened for good once used)
    if (link.kind === KIND.LOCK && link.locked) {
      const held = G.keys.indexOf(link.color);
      if (held < 0) {
        sfx.lock();
        toast(`LOCK · YOU NEED A ${PALETTE[link.color].name} KEY`, 'bad');
        bump(axis, dir);
        return;
      }
      G.keys.splice(held, 1);
      award(from, to, axis, link.color);
      sfx.key();
      toast(`${PALETTE[link.color].name} KEY USED · THE LOCK IS OPEN`, 'good');
      tune(link, axis, dir, from, to);
      arrive(to);
      return;
    }

    if (link.locked && link.color !== G.color) {
      sfx.lock();
      toast(`${KIND_NAME(link.kind)} · NEEDS ${PALETTE[link.color].name} - YOU ARE ${PALETTE[G.color].name}`, 'bad');
      bump(axis, dir);
      return;
    }

    if (link.locked) {
      award(from, to, axis, link.color);
      tune(link, axis, dir, from, to);
    }
    sfx.step();
    arrive(to);
  }

  const KIND_NAME = k => k === KIND.LADDER ? 'LADDER' : k === KIND.GATE ? 'AXIS GATE' : 'DOOR';

  function award(from, to, axis, color) {
    const id = Math.min(idxOf(from), idxOf(to)) + ':' + axis;
    if (G.unlocked.has(id)) return;
    G.unlocked.add(id);
    G.points += 1;
    sfx.match();
    toast(`RESONANCE +1 · ${PALETTE[color].name} MATCHED`, 'good');
  }

  // matching a barrier TUNES it: passable in both directions for the rest of the run,
  // so every step of +1 can always be undone with -1
  function tune(link, axis, dir, from, to) {
    link.locked = false;
    link.tuned = true;
    const back = G.links[idxOf(to)].get(LK(axis, -dir));
    if (back && back.to === idxOf(from)) { back.locked = false; back.tuned = true; }
  }

  function arrive(to) {
    G.player.c = to;
    const i = idxOf(to);
    if (!G.visited[i]) { G.visited[i] = 1; refreshSensed(); }

    // key pickup
    if (G.keyAt[i] >= 0 && !G.keyGone[i]) {
      G.keyGone[i] = 1;
      G.keys.push(G.keyAt[i]);
      sfx.key();
      toast(`${PALETTE[G.keyAt[i]].name} KEY PICKED UP`, 'good');
    }

    // signature pad
    if (G.pads[i] >= 0 && G.pads[i] !== G.color) setColor(G.pads[i], true);
    else sfx.step();

    G.history.push(to.slice());
    if (G.history.length > 3) G.history.shift();
    G.mapDirty = true; G.rev++;
    // The map centers on you, so moving must leave the page offset alone. It used
    // to be set to your own coordinate on the scroll axis - correct when the page
    // was a slice index, but with the page now an offset from you it scrolled the
    // map clean off your room and left it blank.
    G.mapPage = clampPage(G.mapPage);

    if (i === G.exit) win();
    updateHUD();
  }

  function bump(axis, dir) {
    G.player.f[axis] += dir * 0.34;
  }

  function setColor(ci, pad) {
    G.color = ((ci % PALETTE.length) + PALETTE.length) % PALETTE.length;
    sfx.color();
    const p = PALETTE[G.color];
    toast(pad ? `SIGNATURE RESONATES · ${p.name}` : `SIGNATURE · ${p.name}`, pad ? 'axis' : 'good');
    const sw = document.getElementById('color-swatch');
    sw.style.color = p.hex;
    sw.style.borderColor = p.hex + '66';
    document.getElementById('color-glyph').textContent = p.glyph;
    document.getElementById('color-glyph').style.color = p.hex;
    document.getElementById('color-name').textContent = p.name;
    updateHUD();
  }

  function cyclePlane(dir) {
    G.planeIx = (G.planeIx + (dir || 1) + PLANE_PAIRS.length) % PLANE_PAIRS.length;
    if (!freeAxes().includes(G.depthAx)) G.depthAx = freeAxes()[0];
    // the page is an offset from where you stand, and a new plane does not move
    // you, so only the bound needs re-checking
    G.mapPage = clampPage(G.mapPage);
    G.mapDirty = true; G.rev++;
    CACHES.mini.key = ''; CACHES.full.key = '';
    sfx.axis();
    const p = planeAxes();
    toast(`PLANE · ${AXIS_NAME[p[0]]} / ${AXIS_NAME[p[1]]}   DEPTH · ${AXIS_NAME[depthAxis()]}`, 'axis');
    updateHUD();
  }

  function cycleDepth(dir) {
    const free = freeAxes();
    const cur = Math.max(0, free.indexOf(depthAxis()));
    G.depthAx = free[(cur + (dir || 1) + free.length) % free.length];
    // the spare axis changed with it, so the page bound has to be re-checked and
    // both maps redrawn from scratch
    G.mapPage = clampPage(G.mapPage);
    G.mapDirty = true; G.rev++;
    CACHES.mini.key = ''; CACHES.full.key = '';
    sfx.axis();
    toast(`DEPTH AXIS · ${AXIS_NAME[G.depthAx]}`, 'axis');
    updateHUD();
  }

  function win() {
    G.done = true;
    sfx.win();
    const secs = Math.round(G.time);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');

    if (CFG.mode === 'lockdown') PROGRESS.lockdownWins++; else PROGRESS.regularWins++;
    saveProgress();

    const justUnlocked = bigUnlocked();
    document.getElementById('win-stats').textContent =
      `Slice resolved in ${mm}:${ss} · ${CFG.mode} · ${DIMS.join('x')} · ` +
      `${G.points} resonance · ${G.locks} locks opened · ${G.keys.length} keys left. ` +
      (justUnlocked
        ? `Both disciplines mastered: the lattice now opens up to ${SIZE_BIG} per axis.`
        : `Lockdown ${Math.min(PROGRESS.lockdownWins, WINS_TO_UNLOCK)}/${WINS_TO_UNLOCK} · ` +
          `regular ${Math.min(PROGRESS.regularWins, WINS_TO_UNLOCK)}/${WINS_TO_UNLOCK} cleared.`);

    const best = Number(store.get('penteraction.best') || 0);
    if (!best || secs < best) {
      store.set('penteraction.best', String(secs));
      document.getElementById('best-time').textContent = `${mm}:${ss}`;
    }
    document.getElementById('win-config').textContent =
      `${CFG.mode.toUpperCase()} · ${DIMS.join('x')} · ` +
      `${CFG.gateColors} gate color${CFG.gateColors === 1 ? '' : 's'} · render ${CFG.renderDist}`;
    document.getElementById('win').classList.add('show');
    hideToast(); syncToastPage();
    refreshSetup();
  }

  function newRun() {
    generate((Math.random() * 0xffffffff) >>> 0);
    document.getElementById('win').classList.remove('show');
    hideToast(); syncToastPage();
    setColor(0, true);
    updateHUD();
    if (G.trimmed) toast('DEPTH AXES TRIMMED TO FIT THE ROOM BUDGET', 'axis');
  }

  /* ---------------------------------------------------------
     7. HUD
     --------------------------------------------------------- */
  function updateHUD() {
    const p = planeAxes();
    const da = depthAxis();
    const dv = G.player.c[da];
    document.getElementById('hud-slice').textContent =
      `${AXIS_NAME[p[0]]}${AXIS_NAME[p[1]]}-plane · ${CFG.mode}`;
    document.getElementById('hud-coords').textContent = '[' + G.player.c.join(' ') + ']';
    document.getElementById('hud-plane').textContent = `${AXIS_NAME[p[0]]} / ${AXIS_NAME[p[1]]}`;
    document.getElementById('hud-depth').textContent =
      `${AXIS_NAME[da]} ${dv} (${dv === 0 ? '0' : dv > (DIMS[da] - 1) / 2 ? AXIS_POS[da] : AXIS_NEG[da]})`;
    document.getElementById('hud-points').textContent = `${G.points} ●`;
    document.getElementById('hud-keys').textContent = G.keys.length
      ? G.keys.map(c => PALETTE[c].glyph).join(' ')
      : 'none';
    document.getElementById('hud-keys').style.color = G.keys.length ? PALETTE[G.keys[0]].hex : '';
    updateRoomTag();
  }

  /* ---------------------------------------------------------
     8. MAIN RENDER - the current slice stack
     --------------------------------------------------------- */
  const TRAIL = [];

  // rebuild the projected basis from the camera. yaw turns the lattice around
  // the depth axis, pitch tips it towards or away from you.
  function updateBasis() {
    const cy = Math.cos(G.yaw), sy = Math.sin(G.yaw);
    const cp = Math.cos(G.pitch), sp = Math.sin(G.pitch);
    BAS.ax.x = cy * CAM_SP;    BAS.ax.y = sy * sp * CAM_SP;
    BAS.ay.x = -sy * CAM_SP;   BAS.ay.y = cy * sp * CAM_SP;
    BAS.az.x = 0;              BAS.az.y = -cp * CAM_SD;
    // tile corners: the top face of the room, projected
    const ax = BAS.ax, ay = BAS.ay;
    CORN = [
      { x: -ax.x * 0.5 - ay.x * 0.5, y: -ax.y * 0.5 - ay.y * 0.5 },
      { x: ax.x * 0.5 - ay.x * 0.5, y: ax.y * 0.5 - ay.y * 0.5 },
      { x: ax.x * 0.5 + ay.x * 0.5, y: ax.y * 0.5 + ay.y * 0.5 },
      { x: -ax.x * 0.5 + ay.x * 0.5, y: -ax.y * 0.5 + ay.y * 0.5 },
    ];
  }

  function cellScreen(c) {
    const p = planeAxes(), da = depthAxis();
    const d0 = c[p[0]] - G.player.c[p[0]];
    const d1 = c[p[1]] - G.player.c[p[1]];
    const dd = c[da] - G.player.c[da];
    // FIT scales the offsets, not just the room art: the plane spacing and the
    // room size both need it, so the tiles meet edge to edge instead of floating
    // apart with a strip of background between them.
    const x = BAS.ax.x * d0 + BAS.ay.x * d1 + BAS.az.x * dd;
    const y = BAS.ax.y * d0 + BAS.ay.y * d1 + BAS.az.y * dd;
    return { x: CX + x * ZOOM * FIT, y: CY + y * ZOOM * FIT };
  }


  function lightOf(i) {
    const c = coordOf(i);
    let pd = 0;
    for (let a = 0; a < 5; a++) pd += Math.abs(c[a] - G.player.c[a]);
    if (pd === 0) return 1;
    if (pd === 1) return 0.5;
    if (G.visited[i]) return 0.6;
    if (G.sensed[i]) return 0.3;
    return 0.12;
  }

  const GRADS = new Map();
  function floorGrad(lit) {
    const q = Math.round(lit * 5) / 5;                 // quantise: 6 cached gradients
    let g = GRADS.get(q);
    if (!g) {
      g = ctx.createLinearGradient(0, -TILE_HH, 0, TILE_HH);
      g.addColorStop(0, `rgba(${18 + q * 26},${22 + q * 32},${30 + q * 40},1)`);
      g.addColorStop(1, `rgba(${8 + q * 12},${9 + q * 14},${13 + q * 18},1)`);
      GRADS.set(q, g);
    }
    return g;
  }

  // Room edges, gathered while the rooms are drawn and stroked once at the end.
  // Every edge belongs to two rooms - or to one room on the outside of the
  // lattice - so each was being stroked by both of them. A passage you can walk
  // through therefore appeared as two lines, and a shared wall came out twice as
  // thick as an outer one.
  let ROOM_EDGES = new Map();
  // How many duplicate edge reports were dropped this frame. Both rooms know about
  // the edge they share, so without this every wall, passage, lock and gate would
  // be drawn twice; this is the count that proves the dedupe is doing its job.
  const EDGE_STATS = { queued: 0, deduped: 0 };
  const edgeKey = (x1, y1, x2, y2) => {
    // the two rooms compute a shared edge from opposite ends, so round before
    // comparing or the pair looks like two different edges
    const r = v => Math.round(v * 100) / 100;
    return x1 < x2 || (x1 === x2 && y1 <= y2)
      ? r(x1) + '|' + r(y1) + '|' + r(x2) + '|' + r(y2)
      : r(x2) + '|' + r(y2) + '|' + r(x1) + '|' + r(y1);
  };
  function pushRoomEdge(A, B, col, lw, glow, isCur) {
    const k = edgeKey(A.x, A.y, B.x, B.y);
    const prev = ROOM_EDGES.get(k);
    // your own room keeps its highlight even though the neighbor queued the same
    // edge first
    if (prev) {
      EDGE_STATS.deduped++;
      if (prev.isCur || !isCur) return;
    } else EDGE_STATS.queued++;
    ROOM_EDGES.set(k, { x1: A.x, y1: A.y, x2: B.x, y2: B.y, col, lw, glow, isCur });
  }
  function drawRoomEdges() {
    if (!ROOM_EDGES.size) return;
    ctx.lineCap = 'round';
    for (const e of ROOM_EDGES.values()) {
      ctx.strokeStyle = e.col;
      ctx.lineWidth = e.lw;
      ctx.shadowBlur = e.glow;
      if (e.glow) ctx.shadowColor = e.col;
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ROOM_EDGES = new Map();
  }

  // Locks and gate bars sit on the edge two rooms share, so each was drawn once by
  // each of them - two padlocks, two bars, stacked on the same spot. They are
  // queued with the transform they need and replayed once, keyed by the edge.
  let DEFERRED = [];
  function deferEdge(A, B, scx, scy, sc, alpha, fn) {
    const k = edgeKey(scx + A.x * sc, scy + A.y * sc, scx + B.x * sc, scy + B.y * sc);
    if (DEFERRED.some(j => j.k === k)) { EDGE_STATS.deduped++; return; }
    EDGE_STATS.queued++;
    DEFERRED.push({ k, x: scx, y: scy, s: sc, alpha, fn });
  }
  function runDeferred() {
    for (const j of DEFERRED) {
      ctx.save();
      ctx.globalAlpha = j.alpha;
      ctx.translate(j.x, j.y);
      ctx.scale(j.s, j.s);
      j.fn();
      ctx.restore();
    }
    DEFERRED = [];
  }

  function draw() {
    EDGE_STATS.queued = 0; EDGE_STATS.deduped = 0;
    const t = performance.now() / 1000;
    // Behind the main menu there is no game view at all: paint the backdrop the
    // menu sits on and stop, so the lattice never peeks out behind the card.
    if (pageUp()) {
      ctx.fillStyle = '#08090c';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    ctx.fillStyle = '#0d0d0f';
    ctx.fillRect(0, 0, W, H);

    // the camera eases toward whatever the drag is pointing at
    G.yaw += (G.yawT - G.yaw) * 0.18;
    G.pitch += (G.pitchT - G.pitch) * 0.18;
    updateBasis();
    // wheel zooms the game view itself, anchored on the middle of the lattice
    const vs = G.viewZoom;
    ctx.save();
    if (vs !== 1) { ctx.translate(CX, CY); ctx.scale(vs, vs); ctx.translate(-CX, -CY); }
    drawBackgroundGrid(t);

    const p = planeAxes();
    const da = depthAxis();
    const R = CFG.renderDist;
    const dMax = Math.max(1, Math.min(R, 2));           // at most 4 depth slices on screen
    const budget = 460;
    let span = R;
    while ((2 * span + 1) * (2 * span + 1) * (dMax + 2) > budget && span > 1) span--;
    // The lattice is scaled down to fit, and that factor has to be known before
    // the first cellScreen() call below, since cellScreen() uses it to place the
    // room centers. Room size uses the same factor, which is what makes the tiles
    // line up edge to edge.
    const shrink = Math.max(0.4, Math.min(1, 4.4 / (span + 1.6)));
    FIT = shrink;

    const items = [];
    for (let dd = -1; dd <= dMax; dd++) {
      const dv = G.player.c[da] + dd;
      if (dv < 0 || dv >= DIMS[da]) continue;
      const scale = 1 / (1 + 0.34 * Math.abs(dd) + (dd < 0 ? 0.1 : 0));
      const fade = dd === 0 ? 1 : Math.max(0.1, 0.44 - 0.11 * Math.abs(dd));
      for (let a0 = -span; a0 <= span; a0++) {
        for (let a1 = -span; a1 <= span; a1++) {
          const c = G.player.c.slice();
          c[da] = dv; c[p[0]] += a0; c[p[1]] += a1;
          if (!inBounds(c)) continue;
          const sc = cellScreen(c);
          items.push({ c, dd, scale, fade, a0, a1, sy: sc.y, sx: sc.x });
        }
      }
    }
    items.sort((m, n) => (m.sy - n.sy) || (m.sx - n.sx));


    for (const it of items) drawCell(it, t, shrink);
    // Edges shared by two rooms, and the locks and gates standing on them, are
    // stroked once here rather than once per room: a passage you can walk through
    // is a single line, and a wall between two rooms is a single line.
    drawRoomEdges();
    runDeferred();
    drawPlayer(t);
    drawBlockedDepth(t, shrink);      // on top of the glow so it is always visible
    drawTrail();
    ctx.restore();
    if (G.showMap) drawMinimap();
  }

  function drawBackgroundGrid(t) {
    ctx.save();
    ctx.strokeStyle = 'rgba(120,170,210,0.045)';
    ctx.lineWidth = 1;
    const step = TILE_HW * 2 * ZOOM * 2;
    const ox = (CX + t * 6) % step, oy = CY % step;
    ctx.beginPath();
    for (let x = ox - step; x < W + step; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = oy - step; y < H + step; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.restore();
  }

  function drawCell(it, t, shrink) {
    const i = idxOf(it.c);
    const p = planeAxes();
    const da = depthAxis();
    const base = PALETTE[G.color];
    const lit = lightOf(i);
    if (lit < 0.16 && it.dd !== 0) return;              // too dark to matter: skip
    const s = it.scale * ZOOM * shrink;
    const sc = cellScreen(it.c);
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.6 + it.c[0] + it.c[1] * 1.3 + it.c[da] * 0.7);
    const isCur = it.dd === 0 && it.a0 === 0 && it.a1 === 0;

    ctx.save();
    ctx.translate(sc.x, sc.y);
    ctx.scale(s, s);
    ctx.globalAlpha = isCur ? 1 : it.fade * (0.22 + lit * 0.95);

    // The room's four edges are stroked one at a time, further down, and only
    // where the room actually has an edge to show. Stroking the whole diamond here
    // drew every shared edge twice - once for each of the two rooms it belongs to -
    // which is why a passage you can walk through appeared as two lines.
    ctx.beginPath();
    ctx.moveTo(CORN[0].x, CORN[0].y);
    ctx.lineTo(CORN[1].x, CORN[1].y);
    ctx.lineTo(CORN[2].x, CORN[2].y);
    ctx.lineTo(CORN[3].x, CORN[3].y);
    ctx.closePath();
    ctx.fillStyle = floorGrad(lit); ctx.fill();

    if (lit > 0.4) {                                    // hatch only where it reads
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(150,200,240,0.07)';
      ctx.lineWidth = 1 / s;
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        const hx = CORN[0].x + (CORN[3].x - CORN[0].x) * t;
        const hy = CORN[0].y + (CORN[3].y - CORN[0].y) * t;
        const ex = CORN[1].x + (CORN[2].x - CORN[1].x) * t;
        const ey = CORN[1].y + (CORN[2].y - CORN[1].y) * t;
        const dx = ex - hx, dy = ey - hy;
        ctx.moveTo(hx - dx, hy - dy); ctx.lineTo(ex + dx, ey + dy);
      }
      ctx.stroke();
      ctx.restore();
    }

    const outlineCol = isCur ? base.hex + 'aa' : `rgba(150,200,240,${0.16 + lit * 0.4})`;
    const outlineLw = (isCur ? 1.6 : 1) / s;
    const outlineGlow = isCur ? 16 * pulse : 0;
    // Room edges are collected in room-local coordinates but stroked after this
    // room's transform is popped, so they are converted to screen space here. The
    // widths and glow are scaled to match, or they would come out s times too thin.
    const edgePt = pt => ({ x: sc.x + pt.x * s, y: sc.y + pt.y * s });
    const pushEdge = (A, B, col, lw, glow) =>
      pushRoomEdge(edgePt(A), edgePt(B), col, lw * s, glow * s, isCur);

    // walls / doors along the two plane axes. each edge is the pair of tile
    // corners that faces that neighbor, so it follows the camera exactly
    const sides = [
      { ax: p[0], dir: +1, ca: 1, cb: 2 },     // +a0
      { ax: p[0], dir: -1, ca: 3, cb: 0 },     // -a0
      { ax: p[1], dir: +1, ca: 2, cb: 3 },     // +a1
      { ax: p[1], dir: -1, ca: 0, cb: 1 },     // -a1
    ];
    for (const sd of sides) {
      const nb = it.c.slice(); nb[sd.ax] += sd.dir;
      const ok = inBounds(nb);
      const link = ok ? G.links[i].get(LK(sd.ax, sd.dir)) : null;
      const open = !!(link && link.to === idxOf(nb));
      const A = CORN[sd.ca], B = CORN[sd.cb];
      if (!open) {
        // the room's own edge, plus the solid wall standing on it. Both are queued
        // rather than stroked here, because the neighbor room reports the same edge
        // and stroking both is what drew every wall twice as thick as it should be
        // and every passage as two lines.
        pushEdge(A, B, outlineCol, outlineLw, outlineGlow);
        const nbIdx = idxOf(nb);
        deferEdge(A, B, sc.x, sc.y, s, ctx.globalAlpha, () => {
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.lineTo(B.x, B.y);
          ctx.strokeStyle = 'rgba(255,74,74,0.92)';        // solid wall
          ctx.lineWidth = 3 / s;
          // A wide red halo around every wall is what fused neighboring walls
          // into what looked like long straight lines running across the lattice.
          // Keep just enough to lift the wall off the floor, and none at all in
          // colorblind mode, where a glow is exactly what smears a shape.
          ctx.shadowBlur = G.colorblind ? CB_SHADOW : 5;
          ctx.shadowColor = 'rgba(255,74,74,0.5)';
          // in colorblind mode the wall carries its own dash pattern, so it reads
          // as a wall without relying on telling red from green
          ctx.setLineDash(G.colorblind ? dashForWall() : []);
          ctx.lineCap = G.colorblind ? 'butt' : 'round';
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.shadowBlur = 0;
        });
      } else if (link.kind === KIND.LOCK) {
        deferEdge(A, B, sc.x, sc.y, s, ctx.globalAlpha, () => {
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.lineTo(B.x, B.y);
          drawLock(link, A, B, pulse, s);
        });
      } else if (link.locked) {
        deferEdge(A, B, sc.x, sc.y, s, ctx.globalAlpha, () => {
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.lineTo(B.x, B.y);
          drawGateBar(link, A, B, s);
        });
      } else if (link.tuned) {
        const c = PALETTE[link.color >= 0 ? link.color : G.color];
        pushEdge(A, B, c.hex + '55', 1.4 / s, 0);
      } else {
        // an open passage: one line, and only one, however many rooms share it
        pushEdge(A, B, `rgba(150,220,255,${0.22 + lit * 0.3})`, 1 / s, 0);
      }
    }

    if (G.pads[i] >= 0) drawPad(G.pads[i], pulse);
    if (G.keyAt[i] >= 0 && !G.keyGone[i]) {
      G.keyIconIdx = i;
      // sit the key just below the middle of the tile, following the view
      const kx = (BAS.ax.x + BAS.ay.x) * 0.17, ky = (BAS.ax.y + BAS.ay.y) * 0.17;
      drawKeyIcon(kx, ky, 1 / Math.max(0.4, ZOOM * shrink), pulse);
    }

    // Depth axis (Z / W / V). Every top/bottom marker belongs to YOUR room only:
    // the work below is inside isCur, so the slices around you stay completely
    // clean and no other room ever draws a ceiling, floor, cap or seal.
    if (isCur) {
      const upLink = (() => { const n = it.c.slice(); n[da] += 1; return inBounds(n) ? G.links[i].get(LK(da, +1)) : null; })();
      const dnLink = (() => { const n = it.c.slice(); n[da] -= 1; return inBounds(n) ? G.links[i].get(LK(da, -1)) : null; })();
      const upOpen = !!(upLink && upLink.to === idxOf(it.c.map((v, k) => (k === da ? v + 1 : v))));
      const dnOpen = !!(dnLink && dnLink.to === idxOf(it.c.map((v, k) => (k === da ? v - 1 : v))));
      for (const dir of [+1, -1]) {
        const open = dir > 0 ? upOpen : dnOpen;
        const link = dir > 0 ? upLink : dnLink;
        const dy = dir > 0 ? -1 : 1;
        if (!open) continue;
        if (link.kind === KIND.LOCK) drawLockGlyph(link.color, pulse, dy, link.locked);
        else if (link.kind === KIND.LADDER) drawLadder(link, pulse, dy);
        else if (link.locked) drawGateGlyph(link.color, pulse, dy);
        else drawStepChevron(dy, s);
      }
      // The top and bottom of the shaft are shown by the seal emoji below, not
      // by a bar. The bar was the only horizontal line anywhere in the isometric
      // view - every wall runs on one of the two plane axes, which project to
      // diagonals - so it read as a stray line floating over the lattice instead
      // of as part of the room.
      G.blockedDepth = [+1, -1].filter(d => !passable(i, da, d)).map(d => {
        const n = it.c.slice(); n[da] += d;
        return { dir: d, sealed: !inBounds(n) };
      });
    }

    if (i === G.exit) drawExit(pulse);

    ctx.restore();
  }

  function drawGateBar(link, e1, e2, s) {
    const c = PALETTE[link.color];
    // colorblind mode trades the glow for hard edges: a glow behind a dashed
    // line is exactly what smears it into an unreadable blob
    ctx.strokeStyle = c.hex;
    ctx.lineWidth = G.colorblind ? cbWidth(3.4, s) : 3.4 / s;
    ctx.lineCap = G.colorblind ? 'butt' : 'round';
    ctx.shadowBlur = G.colorblind ? CB_SHADOW : 14;
    ctx.shadowColor = c.hex;
    if (G.colorblind) {
      ctx.setLineDash(dashFor(link.color));
      ctx.lineDashOffset = 0;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    if (G.colorblind) {
      // name the color with its glyph, drawn large enough to stay legible
      const mx = (e1.x + e2.x) / 2, my = (e1.y + e2.y) / 2;
      const r = Math.max(4, 4.6);
      ctx.fillStyle = '#0d0d0f';
      ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = c.hex;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = c.hex;
      ctx.font = '600 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(PALETTE[link.color].glyph, mx, my + 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  function drawLock(link, e1, e2, pulse, s) {
    const c = PALETTE[link.color];
    const have = G.keys.indexOf(link.color) >= 0;
    ctx.strokeStyle = c.hex;
    ctx.lineWidth = G.colorblind ? cbWidth(3.6, s) : 3.6 / s;
    ctx.shadowBlur = G.colorblind ? CB_SHADOW : (have ? 18 : 8);
    ctx.shadowColor = c.hex;
    if (G.colorblind) { ctx.setLineDash([6, 3]); ctx.lineDashOffset = 0; }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    const mx = (e1.x + e2.x) / 2, my = (e1.y + e2.y) / 2;
    ctx.fillStyle = '#0d0d0f';
    ctx.beginPath(); ctx.arc(mx, my, G.colorblind ? 5.6 : 5.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = c.hex; ctx.lineWidth = G.colorblind ? 1.8 : 1.3 / s;
    ctx.stroke();
    ctx.fillStyle = c.hex;
    ctx.beginPath(); ctx.arc(mx, my - 1.2, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(mx - 0.6, my, 1.2, 2.4);
    if (have) {
      ctx.globalAlpha = 0.4 + 0.4 * pulse;
      ctx.beginPath(); ctx.arc(mx, my, 7.5 + pulse, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // can the player actually go this way right now?
  function passable(i, axis, dir) {
    const co = coordOf(i);
    const nb = co.slice(); nb[axis] += dir;
    if (!inBounds(nb)) return false;
    const link = G.links[i].get(LK(axis, dir));
    if (!link || link.to !== idxOf(nb)) return false;
    if (link.kind === KIND.LOCK) return G.keys.indexOf(link.color) >= 0;
    if (link.locked) return link.color === G.color;
    return true;
  }

  // red X: you cannot go this way from where you stand
  function drawBlockedX(mx, my, s) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,74,74,0.95)';
    ctx.lineWidth = 2.4 / s;
    ctx.shadowBlur = 9; ctx.shadowColor = 'rgba(255,74,74,0.85)';
    const r = 5.5;
    ctx.beginPath();
    ctx.moveTo(mx - r, my - r); ctx.lineTo(mx + r, my + r);
    ctx.moveTo(mx + r, my - r); ctx.lineTo(mx - r, my + r);
    ctx.stroke();
    ctx.restore();
  }

  // cyan chevrons: an open step along the depth axis. A stacked pair pointing the
  // way you can travel, set well clear of the player dot so the two never merge
  // into one unreadable blob.
  function drawStepChevron(dy, s) {
    ctx.save();
    ctx.strokeStyle = 'rgba(120,235,255,0.95)';
    ctx.lineWidth = 2.2 / s;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowBlur = G.colorblind ? CB_SHADOW : 10;
    ctx.shadowColor = 'rgba(53,224,255,0.85)';
    ctx.beginPath();
    for (let k = 0; k < 2; k++) {
      const y = dy * (12 + k * 8);
      ctx.moveTo(-7, y - dy * 5); ctx.lineTo(0, y); ctx.lineTo(7, y - dy * 5);
    }
    ctx.stroke();
    ctx.restore();
  }

  // a real padlock: shackle + body + keyhole
  function drawLockGlyph(ci, pulse, dy, locked) {
    const c = PALETTE[ci];
    const y = dy * 5;
    ctx.save();
    ctx.globalAlpha = locked ? 0.6 + 0.35 * pulse : 0.32;
    ctx.strokeStyle = c.hex;
    ctx.fillStyle = c.hex;
    ctx.lineWidth = G.colorblind ? 2 : 1.5;
    ctx.shadowBlur = G.colorblind ? CB_SHADOW : 12;
    ctx.shadowColor = c.hex;
    // shackle
    ctx.beginPath();
    ctx.arc(0, y - 3.4, 3.1, Math.PI, 0);
    ctx.stroke();
    // body
    ctx.beginPath();
    ctx.rect(-4.6, y - 1.2, 9.2, 7);
    ctx.fill();
    // keyhole
    ctx.fillStyle = '#0d0d0f';
    ctx.beginPath(); ctx.arc(0, y + 1.6, 1.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(-0.45, y + 1.6, 0.9, 2.6);
    ctx.restore();
  }

  // a real key: bow + shaft + teeth
  function drawKeyIcon(x, y, sc, pulse) {
    const c = PALETTE[G.keyAt[G.keyIconIdx] >= 0 ? G.keyAt[G.keyIconIdx] : 0];
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sc, sc);
    ctx.globalAlpha = 0.7 + 0.3 * pulse;
    ctx.strokeStyle = c.hex;
    ctx.lineWidth = G.colorblind ? 2 : 1.5;
    ctx.lineCap = G.colorblind ? 'butt' : 'round';
    ctx.shadowBlur = G.colorblind ? CB_SHADOW : 12;
    ctx.shadowColor = c.hex;
    ctx.beginPath(); ctx.arc(-4, 0, 3.1, 0, Math.PI * 2); ctx.stroke();   // bow
    ctx.beginPath();
    ctx.moveTo(-1, 0); ctx.lineTo(6.5, 0);                                // shaft
    ctx.moveTo(3, 0); ctx.lineTo(3, 3);                                   // teeth
    ctx.moveTo(5.6, 0); ctx.lineTo(5.6, 3);
    ctx.stroke();
    ctx.restore();
  }

  function drawLadder(link, pulse, dy) {
    const c = PALETTE[link.color >= 0 ? link.color : G.color];
    ctx.save();
    ctx.strokeStyle = c.hex;
    ctx.lineWidth = G.colorblind ? 2 : 1.2;
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 0.6 + 0.3 * pulse;
    ctx.shadowBlur = G.colorblind ? CB_SHADOW : 10;
    ctx.shadowColor = c.hex;
    ctx.beginPath();
    ctx.moveTo(-7, dy * 2); ctx.lineTo(7, dy * 2);
    ctx.moveTo(-5.5, dy * 7); ctx.lineTo(5.5, dy * 7);
    ctx.moveTo(-4, dy * 12); ctx.lineTo(4, dy * 12);
    ctx.stroke();
    ctx.restore();
  }

  function drawGateGlyph(ci, pulse, dy) {
    const c = PALETTE[ci];
    ctx.save();
    ctx.strokeStyle = c.hex;
    ctx.globalAlpha = 0.5 + 0.4 * pulse;
    // no glow in colorblind mode, and an integer stroke so the dashes stay crisp
    ctx.lineWidth = G.colorblind ? 2 : 1.1;
    ctx.lineCap = 'butt';
    ctx.shadowBlur = G.colorblind ? CB_SHADOW : 14;
    ctx.shadowColor = c.hex;
    if (G.colorblind) { ctx.setLineDash(dashFor(ci)); ctx.lineDashOffset = 0; }
    ctx.beginPath();
    ctx.moveTo(-9, dy * 9); ctx.lineTo(9, dy * 9);
    ctx.moveTo(0, dy * 9); ctx.lineTo(0, dy * 1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }


  function drawPad(ci, pulse) {
    const c = PALETTE[ci];
    ctx.save();
    ctx.strokeStyle = c.hex;
    ctx.globalAlpha = 0.55 + 0.35 * pulse;
    ctx.lineWidth = G.colorblind ? 2 : 1.3;
    ctx.lineJoin = 'miter';
    ctx.shadowBlur = G.colorblind ? CB_SHADOW : 12;
    ctx.shadowColor = c.hex;
    if (G.colorblind) { ctx.setLineDash(dashFor(ci)); ctx.lineDashOffset = 0; }
    ctx.beginPath();
    ctx.moveTo(0, -TILE_HH * 0.45); ctx.lineTo(TILE_HW * 0.45, 0);
    ctx.lineTo(0, TILE_HH * 0.45); ctx.lineTo(-TILE_HW * 0.45, 0);
    ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.hex;
    ctx.font = G.colorblind ? '600 13px sans-serif' : '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.glyph, 0, 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

   function drawExit(pulse) {
    ctx.save();
    const g = ctx.createRadialGradient(0, 0, 1, 0, 0, 15);
    g.addColorStop(0, `rgba(255,255,255,${0.55 + 0.35 * pulse})`);
    g.addColorStop(0.4, 'rgba(140,255,90,0.45)');
    g.addColorStop(1, 'rgba(140,255,90,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8cff5a'; ctx.lineWidth = 1.2;
    ctx.shadowBlur = 20; ctx.shadowColor = '#8cff5a';
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const px = Math.cos(a) * 9, py = Math.sin(a) * 9 * 0.55;
      k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.stroke();
    ctx.restore();
  }

  function drawPlayer(t) {
    const p = G.player;
    const p0 = planeAxes(), da = depthAxis();
    const f0 = p.f[p0[0]], f1 = p.f[p0[1]], fd = p.f[da];
    for (let a = 0; a < 5; a++) p.f[a] *= 0.82;
    const x = BAS.ax.x * f0 + BAS.ay.x * f1 + BAS.az.x * fd;
    const y = BAS.ax.y * f0 + BAS.ay.y * f1 + BAS.az.y * fd;
    // FIT here too: the marker has to sit inside the room it is standing in, and
    // the room is drawn at ZOOM * FIT. The trail stores these screen points, so
    // it follows the same scaling.
    const px = CX + x * ZOOM * FIT, py = CY + y * ZOOM * FIT;
    const col = PALETTE[G.color];

    TRAIL.push({ x: px, y: py, life: 1, c: col.hex });
    if (TRAIL.length > 26) TRAIL.shift();
    for (const tr of TRAIL) tr.life -= 0.035;
    while (TRAIL.length && TRAIL[0].life <= 0) TRAIL.shift();

    ctx.save();
    ctx.translate(px, py);
    const r = 7 * ZOOM * FIT * (1 + 0.07 * Math.sin(t * 3.4));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 26 * ZOOM);
    g.addColorStop(0, col.hex + 'cc');
    g.addColorStop(0.35, col.hex + '44');
    g.addColorStop(1, col.hex + '00');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 26 * ZOOM, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#eaf7ff';
    ctx.lineWidth = 1.6;
    ctx.shadowBlur = 22; ctx.shadowColor = col.hex;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = col.hex; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, r + 7 * ZOOM, 0, Math.PI * 2); ctx.stroke();
    if (G.colorblind) {
      ctx.setLineDash(dashFor(G.color));
      ctx.beginPath(); ctx.arc(0, 0, r + 11 * ZOOM, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // your room's coordinate readout - lives in the DOM strip above the buttons
  function updateRoomTag() {
    const el = $('roomtag');
    if (!el) return;
    const p = planeAxes(), da = depthAxis(), c = G.player.c;
    el.innerHTML =
      `<span class="label">ROOM</span>` +
      `<b>${AXIS_NAME[p[0]]}${c[p[0]]} ${AXIS_NAME[p[1]]}${c[p[1]]}</b>` +
      `<span class="dot">&middot;</span>` +
      `<span class="dim"><kbd>Space</kbd> up, <kbd>Shift</kbd> down</span>`;
    const tag = $('tag-depth');
    if (tag) tag.textContent = AXIS_NAME[da];
  }

  // Marks the depth directions you cannot step, drawn over the player glow. A
  // sealed lattice end gets the red seal; a gate or lock you merely lack the
  // color or key for keeps the red X. Both sit further out than the open-step
  // chevrons and are drawn larger, so "can go" and "cannot go" never sit on top
  // of each other or of the dot.
  function drawBlockedDepth(t, shrink) {
    const list = G.blockedDepth;
    if (!list || !list.length) return;
    const s = Math.max(0.45, Math.min(1, 4.4 / (CFG.renderDist + 1.6))) * shrink;
    ctx.save();
    ctx.translate(CX, CY);
    ctx.scale(s, s);
    for (const b of list) {
      const dir = typeof b === 'number' ? b : b.dir;
      const sealed = typeof b === 'object' && b.sealed;
      // markers sit above / below your room along the depth direction, so they
      // follow the camera instead of hugging the screen's vertical axis
      const reach = Math.max(TILE_HH * 1.15, Math.abs(BAS.az.y) * 0.46 + Math.abs(BAS.az.x) * 0.22);
      const y = (dir > 0 ? -1 : 1) * reach;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3);
      ctx.lineCap = 'round';
      if (sealed) {
        // the seal emoji, tinted red. the emoji font supplies the shape; a color
        // emoji carries its own white which would glare, so it is drawn through a
        // tint canvas and flattened onto that color.
        drawSealEmoji(0, y, 22, `rgba(255,74,74,${0.82 + 0.18 * pulse})`);
      } else {
        ctx.strokeStyle = 'rgba(255,74,74,0.95)';
        ctx.lineWidth = 3.4;
        ctx.shadowBlur = G.colorblind ? CB_SHADOW : 12;
        ctx.shadowColor = 'rgba(255,74,74,0.9)';
        const r = 9 + pulse * 0.8;
        ctx.beginPath();
        ctx.moveTo(-r, y - r); ctx.lineTo(r, y + r);
        ctx.moveTo(r, y - r); ctx.lineTo(-r, y + r);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }
    ctx.restore();
  }

  // Draws an emoji glyph recolored to `tint`. The platform emoji font bakes in a
  // white plate, so the glyph is rendered to an offscreen canvas, every opaque
  // pixel is replaced by the tint, and only then composited. Cached per
  // (char, size, tint) because emoji rasterising is not cheap.
  const SEAL_EMOJI = '\u{1F6AB}';
  const EMOJI_CACHE = new Map();
  function tintedEmoji(ch, size, tint) {
    const key = ch + '|' + size + '|' + tint;
    let c = EMOJI_CACHE.get(key);
    if (c) return c;
    const pad = Math.ceil(size * 0.35);
    const dim = Math.ceil(size * 1.6);
    c = document.createElement('canvas');
    c.width = dim; c.height = dim;
    const g = c.getContext('2d');
    g.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(ch, dim / 2, dim / 2);
    // swap every drawn pixel for the tint, keeping the glyph's own alpha
    const img = g.getImageData(0, 0, dim, dim);
    const d = img.data;
    const m = tint.match(/[\d.]+/g).map(Number);
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      d[i] = m[0]; d[i + 1] = m[1]; d[i + 2] = m[2]; d[i + 3] = Math.round(d[i + 3] * (m[3] === undefined ? 1 : m[3]));
    }
    g.putImageData(img, 0, 0);
    EMOJI_CACHE.set(key, c);
    return c;
  }

  // Paint the same recolored seal into the legend swatch, so the legend and the
  // lattice show the identical glyph with no white plate on either.
  function paintSealLegend() {
    const el = document.querySelector('#legend .sym.seal');
    if (!el) return;
    const c = tintedEmoji(SEAL_EMOJI, 17, 'rgba(255,74,74,1)');
    el.style.backgroundImage = `url(${c.toDataURL()})`;
  }

  function drawSealEmoji(x, y, size, tint) {
    const c = tintedEmoji(SEAL_EMOJI, size, tint);
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.drawImage(c, x - c.width / 2, y - c.height / 2);
    ctx.restore();
  }

  function drawTrail() {
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 1; i < TRAIL.length; i++) {
      const a = TRAIL[i - 1], b = TRAIL[i];
      ctx.strokeStyle = b.c;
      ctx.globalAlpha = b.life * 0.25;
      ctx.lineWidth = b.life * 3;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  // Colorblind patterns. These have to stay crisp: fractional dash lengths and
  // sub-pixel strokes are what made the shapes smear, so every length is a
  // whole number of device pixels and each pattern is clearly distinct.
  const CB_PATTERNS = [[], [7, 3], [3, 3], [10, 3, 2, 3], [2, 3], [12, 4]];
  const CB_SHAPES = ['solid', 'dashed', 'dotted', 'dash-dot', 'dashed', 'dash-dot'];
  function dashFor(ci) { return (CB_PATTERNS[ci % CB_PATTERNS.length] || []).slice(); }
  function shapeFor(ci) { return CB_SHAPES[ci % CB_SHAPES.length]; }
  // A wall is red in every mode, and red against green is exactly the pair a
  // colorblind player cannot separate by eye. So in colorblind mode a wall gets
  // its own dash pattern - long dashes, unlike any gate - which is the symbol
  // that says "solid, you cannot pass" without relying on the red at all.
  const CB_WALL_PATTERN = [14, 7];
  function dashForWall() { return CB_WALL_PATTERN.slice(); }
  // colorblind strokes are whole pixels and never thinner than 2, so a zoomed-out
  // gate stays a crisp shape instead of dissolving into a gray smear
  const cbWidth = (w, s) => Math.max(2, Math.round(w / s));
  const CB_SHADOW = 0;
  // The map draws at a fraction of a pixel per room on the minimap, which is
  // what made the colorblind dashes and door bars smear. In colorblind mode the
  // map works in whole device pixels: a minimum stroke, no glow, butt caps, and
  // dashes measured in integers, so the pattern stays legible at any zoom.
  const CB_MIN_PANEL = 46;      // below this the map stops drawing colorblind detail
  function cbUsable(cs) { return cs >= CB_MIN_PANEL * 0.16; }
  const cbLine = (cs, want) => Math.max(2, Math.round(cs * want));

  /* ---------------------------------------------------------
     9. LATTICE MAP
        The map follows your perception, not fixed letters: every panel is the
        plane you are standing in, rows are slices of your CURRENT depth axis,
        and the only other axis on show is the one free axis beside your plane.
        The two axes you cannot currently see are left off entirely - so with an
        X/Y plane and Z depth there is no W row or V page, and cycling the depth
        axis re-lays the map out around the new axis instead of showing stale
        letters. [ ] pages the remaining free axis.
     --------------------------------------------------------- */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // the one axis that is neither in the plane nor the depth axis, if any
  function spareAxis() {
    const p = planeAxes(), d = depthAxis();
    // Take the highest-numbered free axis, so with the usual X/Y plane the map's
    // columns are V. That is the axis [ ] pages, and it used to come out as W,
    // which left V invisible on the map entirely.
    for (let a = 4; a >= 0; a--) if (a !== p[0] && a !== p[1] && a !== d) return a;
    return -1;
  }
  // The map has a fixed frame and does not follow the depth axis you picked:
  // rows are always Z, columns are always W, and [ ] pages through V. Following
  // the depth axis meant the map reoriented every time you pressed X, so you
  // could never learn where anything was.
  const MAP_ROW = 2, MAP_COL = 3, MAP_PAGE = 4;
  const mapAxis = () => {
    const n = DIMS.length;
    return {
      d: clamp(MAP_ROW, 0, n - 1),
      s: clamp(MAP_COL, 0, n - 1),
      v: clamp(MAP_PAGE, 0, n - 1),
    };
  };
  // [ ] pages V. W is the top of the map and Z is the side, always, so the page
  // axis is fixed too.
  let LASTL = null;
  function scrollAxis() {
    return clamp(MAP_PAGE, 0, DIMS.length - 1);
  }
  // A signed page offset from the V slice you are standing in. Clamped to the
  // number of V slices so holding the key down cannot page into empty space.
  const clampPage = v => clamp(v, -DIMS[scrollAxis()], DIMS[scrollAxis()]);

  // The map only changes when you move, discover a room, resize or page.
  // Rebuilding the (potentially 60k room) scan only then keeps big lattices smooth.
  // one cache per map view so they never evict each other
  const NEWCACHE = () => ({ key: '', cells: null, edges: null, links: null, keys: null, marks: null, exit: null, layout: null, counts: null });
  const CACHES = { mini: NEWCACHE(), full: NEWCACHE() };

  // Map walls are drawn per room from this mask, the way the game view draws
  // them: red on every edge with no passage. Each room knows all four of its own
  // edges, so a wall shared by two rooms is reported by both - they are
  // deduplicated by geometry when the cache is built.
  const WALL = { XP: 1, XN: 2, YP: 4, YN: 8 };
  function wallMask(i, co) {
    const p = planeAxes();
    let m = 0;
    if (!G.links[i].get(LK(p[0], +1))) m |= WALL.XP;
    if (!G.links[i].get(LK(p[0], -1))) m |= WALL.XN;
    if (!G.links[i].get(LK(p[1], +1))) m |= WALL.YP;
    if (!G.links[i].get(LK(p[1], -1))) m |= WALL.YN;
    return m;
  }


  function mapLayout(w, h, big) {
    const FAM = getComputedStyle(document.body).fontFamily;
    const nAx = DIMS.length;
    const rawP = planeAxes();
    // The axis helpers reason about five axes, but a lattice can be built with
    // fewer. An index past the end of DIMS made every measurement below NaN,
    // which left the panel grid empty and threw on the first lookup.
    const p = [clamp(rawP[0], 0, nAx - 1), clamp(rawP[1], 0, nAx - 1)];
    const dAx = clamp(MAP_ROW, 0, nAx - 1);      // rows: W
    const sIdx = clamp(MAP_COL, 0, nAx - 1);     // columns: Z
    // The head and foot float over the canvas, so the grid is inset by their real
    // height. Measuring them (instead of guessing 172px) is what stops the map
    // from running off the bottom of the screen.
    const head = big ? document.querySelector('.fullmap-head') : null;
    const foot = big ? document.querySelector('.fullmap-foot') : null;
    const padT = big ? (head ? head.offsetHeight + 26 : 172) : 40;
    const padB = big ? (foot ? foot.offsetHeight + 22 : 56) : 30;
    const padL = big ? 62 : 40, padR = big ? 30 : 22;
    // The grid is centered dead-center horizontally, but centered in the gap the
    // header and footer leave over vertically. The two need different rules.
    // Horizontally the only thing needing room is the row-label gutter on the left,
    // so inset both sides by the larger and the grid itself sits on the window's
    // center line. Vertically the header is a tall block and the footer a thin
    // line, so insetting both sides equally would center on the canvas and leave
    // the grid sitting well above the middle of the gap between them - which reads
    // as off center at any window size. Use their real measured heights per side.
    const padX = Math.max(padL, padR);
    const availW = Math.max(0, (w || 0) - padX * 2);
    const availH = Math.max(0, (h || 0) - padT - padB);
    const page = clampPage(G.mapPage);
    const labelH = big ? 15 : 8;

    // Show as many slices as stay legible. The panel floor decides this, and it
    // has to be small: at 150/118 a 4-slice axis only ever showed 3 of them, so
    // everything past the first slice or two was simply missing from the map.
    const MIN_PANEL = big ? 76 : 54;
    const fit = (n, lim) => {
      n = Math.floor(Number(n)); lim = Math.floor(Number(lim));
      if (!isFinite(n) || n < 1) n = 1;
      if (!isFinite(lim) || lim < 1) lim = 1;
      return Math.max(1, Math.min(lim, n));
    };
    const winRows = fit(Math.floor(availH / MIN_PANEL), DIMS[dAx]);
    const winCols = fit(Math.floor(availW / MIN_PANEL), DIMS[sIdx]);
    const here = G.player.c;
    // Rows follow W and columns follow Z, both centered on where you stand, and
    // neither is ever allowed to leave the lattice - without that clamp you could
    // walk the window off the edge and the map went blank.
    // The window has to stay WHOLLY inside the lattice, so its start is clamped to
    // 0..DIMS - win. Clamping the start to DIMS - 1 instead let it hang off either
    // end, and every row or column that fell outside was skipped when painting -
    // so the grid was laid out centered but only part of it was drawn, which is
    // what left the map visibly off center. You stay inside the window either way:
    // win is never larger than the axis, so clamping cannot push you out of it.
    const z0 = clamp(here[dAx] - ((winRows - 1) >> 1),
                     0, Math.max(0, DIMS[dAx] - winRows));
    const w0 = clamp(here[sIdx] - ((winCols - 1) >> 1),
                     0, Math.max(0, DIMS[sIdx] - winCols));
    // [ ] does not move the grid at all: the grid is W x Z, so paging selects
    // which V slice is drawn inside every panel. That is also why paging can never
    // scroll the map off the lattice.
    const pageAx = clamp(MAP_PAGE, 0, nAx - 1);
    const vShown = clamp(here[pageAx] + page, 0, Math.max(0, DIMS[pageAx] - 1));
    const maxD = Math.max(DIMS[p[0]], DIMS[p[1]]);
    const minPanel = labelH * 2 + 12;         // below this cs comes out negative
    // The grid is laid out as one block centered in the drawable area - it is NOT
    // shifted to put you in the middle, which used to slide the whole map off
    // center and out from under the header.
    const panel = Math.max(minPanel, Math.min(availW / winCols, availH / winRows) * 0.94);
    const cs = (panel - labelH * 2) / maxD;
    const x0 = padX + (availW - winCols * panel) / 2;
    const y0 = padT + (availH - winRows * panel) / 2;
    const P = [];
    for (let r = 0; r < winRows; r++) {
      P[r] = [];
      for (let c = 0; c < winCols; c++) {
        const cx = x0 + c * panel + panel / 2;
        const cy = y0 + r * panel + panel / 2;
        P[r][c] = { cx, cy, x: cx - panel / 2, y: cy - panel / 2, s: panel };
      }
    }
    // Where a dot lands inside its panel: the exact center of its room's cell.
    // Clamped against the grid that was actually built, not against winRows /
    // winCols: if either came out degenerate the lookup would run off the end.
    // The cell block is centered on the panel on BOTH axes. It used to be centered
    // in the panel minus the label strip, which pushed every square down by half a
    // label and left the block visibly off center in its panel - and it dropped it
    // onto the "n found" caption at the bottom.
    const dotAt = co => {
      const rows = P.length, cols = rows ? P[0].length : 1;
      const rr = clamp(co[dAx] - z0, 0, Math.max(0, rows - 1));
      const cc = clamp(co[sIdx] - w0, 0, Math.max(0, cols - 1));
      const r = P[rr] && P[rr][cc] ? P[rr][cc] : { x: 0, y: 0, s: panel };
      const ox = r.x + (panel - DIMS[p[0]] * cs) / 2;
      const oy = r.y + (panel - DIMS[p[1]] * cs) / 2;
      return { x: ox + (co[p[0]] + 0.5) * cs, y: oy + (co[p[1]] + 0.5) * cs };
    };
    return {
      P, winCols, winRows, w0, z0, page, vShown, cs, labelH, panel, dAx, p, sIdx,
      pageAx, scrollAx: pageAx,
      // center of the drawable area, used to put your own dot in the middle
      cxp: padX + availW / 2, cyp: padT + availH / 2,
      fs: n => `${Math.max(4, Math.round(n))}px ${FAM}`,
      at: dotAt,
    };  }


  function rebuildMap(MAPCACHE, L, big) {
    const here = G.player.c;
    const p = L.p, dAx = L.dAx, sIdx = L.sIdx, pageAx = L.pageAx;
    // A panel is one (W, Z, V) slice of the lattice. W and Z have to be inside the
    // window, and V has to be the slice [ ] is currently showing - which is what
    // makes paging V replace the contents of the grid instead of moving it.
    const inWin = co => co[dAx] >= L.z0 && co[dAx] < L.z0 + L.winRows
                      && co[sIdx] >= L.w0 && co[sIdx] < L.w0 + L.winCols
                      && co[pageAx] === L.vShown;
    const cells = [], edges = [], links = [], keys = [], marks = [];
    const counts = new Int32Array(L.winRows * L.winCols);
    MAPCACHE.exit = null;
    for (let i = 0; i < SIZE; i++) {
      const co = coordOf(i);
      if (!inWin(co)) continue;
      const pt = L.at(co);
      const slot = (co[dAx] - L.z0) * L.winCols + (co[sIdx] - L.w0);
      if (i === G.exit) { MAPCACHE.exit = { x: pt.x, y: pt.y }; continue; }
      const found = !!G.visited[i];
      if (!found && !G.sensed[i]) continue;
      if (found) counts[slot]++;
      const bright = found && co[dAx] === here[dAx] && co[sIdx] === here[sIdx];
      // A room fills its whole cell, so the red walls sit exactly on its edges
      // instead of floating a gap outside a smaller square. The cell's top-left
      // corner is stored rather than its center, which is what lets the walls line
      // up on the shared edges between two rooms.
      const q = L.P[co[dAx] - L.z0][co[sIdx] - L.w0];
      // same centering as dotAt: the cell block is centered on the panel, so the
      // squares line up with the panel border and with each other
      const cellX = q.x + (L.panel - DIMS[p[0]] * L.cs) / 2 + co[p[0]] * L.cs;
      const cellY = q.y + (L.panel - DIMS[p[1]] * L.cs) / 2 + co[p[1]] * L.cs;
      // stride 4: cell x, cell y, kind (0 sensed, 1 found, 2 found + your slice), wall mask
      cells.push(cellX, cellY, found ? (bright ? 2 : 1) : 0, found ? wallMask(i, co) : 0);
      if (!found) continue;

      // Solid edges of the room. Both rooms either side of a wall hold it, so
      // every shared edge arrives here twice; they are deduplicated by geometry
      // when the cache is built. Without that, a wall between two rooms was
      // stroked twice and came out visibly thicker than a wall on the outside.
      const mask = wallMask(i, co);
      const cw = L.cs;
      if (mask & WALL.XP) edges.push(cellX + cw, cellY, cellX + cw, cellY + cw);
      if (mask & WALL.XN) edges.push(cellX, cellY, cellX, cellY + cw);
      if (mask & WALL.YP) edges.push(cellX, cellY + cw, cellX + cw, cellY + cw);
      if (mask & WALL.YN) edges.push(cellX, cellY, cellX + cw, cellY);

      // doors / gates / ladders / locks are only charted for rooms you have found
      const half = L.cs * 0.5;
      for (let a = 0; a < 5; a++) {
        for (const dir of [+1, -1]) {
          const link = G.links[i].get(LK(a, dir));
          if (!link) continue;
          const isLock = link.kind === KIND.LOCK;
          if (!link.locked && !isLock) continue;          // plain opening: the gap shows it
          // Passages are two-way, so both rooms hold this link and both would
          // chart a mark for it - two identical strokes on the same spot, which
          // is what smeared the colorblind dash patterns. Only the lower room
          // charts it.
          if (link.to < i) continue;
          const onPlane = a === p[0] || a === p[1];
          const kind = isLock ? 3 : (onPlane ? 1 : 2);      // 2 = off the plane
          let mx, my;
          if (onPlane) {
            // on the shared edge of the two inner cells
            mx = pt.x + (a === p[0] ? dir * half : 0);
            my = pt.y + (a === p[1] ? dir * half : 0);
          } else if (a === L.dAx) {
            // up or down the depth axis: a bar just inside your own panel
            mx = pt.x;
            my = pt.y + (dir > 0 ? -half * 0.55 : half * 0.55);
          } else if (a === sIdx) {
            // across to the neighboring panel: on the panel edge it crosses,
            // which is also where its wall would otherwise be drawn
            const q = L.P[co[dAx] - L.z0][co[sIdx] - L.w0];
            mx = q.x + (dir > 0 ? q.s : 0);
            my = q.y + q.s * 0.5;
          } else {
            continue;      // an axis this map is not showing: nothing to draw it on
          }
          marks.push(mx, my, kind, link.color, a === p[0] ? 0 : 1);
        }
      }
      // Passages inside the panel, along the two plane axes. A gated passage is
      // skipped here: its door is already charted as a single bar on the shared
      // edge by the marks above, and drawing the center-to-center line as well
      // is what made every gate and ladder look like two lines.
      for (let n2 = 0; n2 < 2; n2++) {
        const link = G.links[i].get(LK(p[n2], +1));
        if (!link || !G.visited[link.to]) continue;
        if (link.locked || link.kind === KIND.LOCK) continue;
        if (link.to < i) continue;                 // one line per passage, not two
        const n = coordOf(link.to);
        if (n[sIdx] !== co[sIdx] || n[dAx] !== co[dAx]) continue;
        const q = L.at(n);
        // Stop the line at the edge of each room square instead of running it
        // center to center. Overlapping the squares is what made one passage read
        // as two separate strokes poking out either side of a room.
        const dx = q.x - pt.x, dy = q.y - pt.y, len = Math.hypot(dx, dy) || 1;
        const inset = Math.min(L.cs * 0.3, len * 0.4);
        links.push(pt.x + dx / len * inset, pt.y + dy / len * inset,
                   q.x - dx / len * inset, q.y - dy / len * inset, -1);
      }
    }
    for (let i = 0; i < SIZE; i++) {
      if (G.keyAt[i] < 0 || G.keyGone[i]) continue;
      const co = coordOf(i);
      if (!inWin(co)) continue;
      const pt = L.at(co);
      keys.push(pt.x, pt.y, G.keyAt[i]);
    }
    // One stroke per wall. The two rooms sharing a wall each report it, and they
    // compute the shared edge from opposite ends, so the key is rounded or the
    // pair looks distinct and both get stroked.
    const q2 = v => Math.round(v * 100) / 100;
    const uniqE = [], seenE = new Set();
    for (let i = 0; i < edges.length; i += 4) {
      const ax1 = edges[i], ay1 = edges[i + 1], ax2 = edges[i + 2], ay2 = edges[i + 3];
      const fwd = ax1 < ax2 || (ax1 === ax2 && ay1 <= ay2);
      const kE = fwd ? q2(ax1) + '|' + q2(ay1) + '|' + q2(ax2) + '|' + q2(ay2)
                     : q2(ax2) + '|' + q2(ay2) + '|' + q2(ax1) + '|' + q2(ay1);
      if (seenE.has(kE)) continue;
      seenE.add(kE);
      uniqE.push(ax1, ay1, ax2, ay2);
    }
    // Same for the passage lines: one line per passage, never two.
    const uniqL = [], seenL = new Set();
    for (let i = 0; i < links.length; i += 5) {
      const lx1 = links[i], ly1 = links[i + 1], lx2 = links[i + 2], ly2 = links[i + 3];
      const col = links[i + 4];
      const fwd = lx1 < lx2 || (lx1 === lx2 && ly1 <= ly2);
      const kL = fwd ? q2(lx1) + '|' + q2(ly1) + '|' + q2(lx2) + '|' + q2(ly2)
                     : q2(lx2) + '|' + q2(ly2) + '|' + q2(lx1) + '|' + q2(ly1);
      if (seenL.has(kL)) continue;
      seenL.add(kL);
      uniqL.push(lx1, ly1, lx2, ly2, col);
    }
    // Two rooms that share an edge both know about the passage between them, so
    // the same mark can arrive twice, and a gate sitting on a panel corner can be
    // reached from more than one room. Keep one of each distinct mark: stroking a
    // repeat puts two identical marks on the same pixels, which is what made the
    // colorblind dash patterns look blurry.
    const uniq = [], seenMark = new Set();
    for (let i = 0; i < marks.length; i += 5) {
      const k = marks[i] + '|' + marks[i + 1] + '|' + marks[i + 2] + '|' + marks[i + 3];
      if (seenMark.has(k)) continue;
      seenMark.add(k);
      uniq.push(marks[i], marks[i + 1], marks[i + 2], marks[i + 3], marks[i + 4]);
    }
    MAPCACHE.cells = Float32Array.from(cells);
    MAPCACHE.edges = Float32Array.from(uniqE);
    MAPCACHE.links = Float32Array.from(uniqL);
    MAPCACHE.keys = Float32Array.from(keys);
    MAPCACHE.marks = Float32Array.from(uniq);
    MAPCACHE.counts = counts;
    MAPCACHE.layout = L;
  }

  function renderMap(m, w, h, big, zoom) {
    const MAPCACHE = CACHES[big ? 'full' : 'mini'];
    const z = zoom || 1;
    const k0 = big ? 1 : 1.9;         // minimap backing store is larger than its box
    m.save();
    m.clearRect(0, 0, w, h);
    m.fillStyle = big ? 'rgba(8,9,12,0.5)' : '#0a0a0c';
    m.fillRect(0, 0, w, h);

    // layout always fits the viewport; zoom then scales that layout about your
    // own dot, so 50% really is half size and 400% is 4x - and you stay put
    const L = mapLayout(w, h, big);
    LASTL = L;
    const here = G.player.c;
    const sIdx = L.sIdx;
    // Scale about the middle of the space the head and foot leave over, which is
    // the same point the grid is centered on. Two earlier anchors were both wrong:
    // zooming about your own room made wherever you stood the fixed point, so the
    // grid slid off center the moment you zoomed (138px at 1.5x, 828px at 4x), and
    // zooming about the raw canvas center ignored the tall header block and left
    // the map sitting high inside its own gap. Anchoring on L.cxp / L.cyp keeps
    // the map centered at every zoom level.
    if (z !== 1) {
      m.translate(L.cxp, L.cyp);
      m.scale(z, z);
      m.translate(-L.cxp, -L.cyp);
    }

    const key = [w, h, big ? 1 : 0, DIMS.join(','), G.planeIx, L.dAx, L.sIdx,
                 L.page, L.w0, L.z0, G.rev, here[L.dAx], here[sIdx], here[L.pageAx]].join('|');
    if (MAPCACHE.key !== key) { rebuildMap(MAPCACHE, L, big); MAPCACHE.key = key; }

    const { P, winCols, winRows, w0, z0, page, cs, labelH, fs, at, dAx } = L;
    // colorblind mode on the map: whole-pixel strokes and no glow, so the dash
    // patterns stay sharp instead of smearing at small cell sizes
    const cb = G.colorblind;
    // the minimap is displayed smaller than its backing store, so scale its text up
    const k = k0;
    const txt = n => fs(n * k / z);         // constant on-screen size at any zoom
    const exitC = coordOf(G.exit);

    // axis labels name the axes you are actually looking down, never fixed letters
    const colName = AXIS_NAME[sIdx], rowName = AXIS_NAME[dAx];
    for (let c = 0; c < winCols; c++) {
      const cc = w0 + c;
      if (cc < 0 || cc >= DIMS[sIdx]) continue;
      m.fillStyle = 'rgba(178,150,255,0.6)';
      m.font = txt(15);
      m.textAlign = 'center';
      m.fillText(`${colName}${cc}`, P[0][c].cx, P[0][c].y - (big ? 8 : 5));
    }
    for (let r = 0; r < winRows; r++) {
      const rr = z0 + r;
      if (rr < 0 || rr >= DIMS[dAx]) continue;
      m.fillStyle = 'rgba(178,150,255,0.6)';
      m.font = txt(15);
      m.textAlign = 'right';
      m.fillText(`${rowName}${rr}`, P[r][0].x - (big ? 8 : 5), P[r][0].y + (big ? 12 : 8));
    }
    m.textAlign = 'left';

    for (let r = 0; r < winRows; r++) {
      const zz = z0 + r;
      if (zz < 0 || zz >= DIMS[dAx]) continue;      // window runs past the lattice
      for (let c = 0; c < winCols; c++) {
        const ww = w0 + c;
        if (ww < 0 || ww >= DIMS[sIdx]) continue;
        const q = P[r][c];
        const onPage = here[L.pageAx] === L.vShown;
        const mine = here[dAx] === zz && here[sIdx] === ww && onPage;
        const holdsExit = exitC[dAx] === zz && exitC[sIdx] === ww
                       && exitC[L.pageAx] === L.vShown;
        m.strokeStyle = mine ? 'rgba(53,224,255,0.75)'
          : holdsExit ? 'rgba(140,255,90,0.4)' : 'rgba(150,200,240,0.18)';
        m.lineWidth = mine ? 1.4 : 1;
        if (mine) { m.shadowBlur = cb ? CB_SHADOW : (big ? 10 : 0); m.shadowColor = 'rgba(53,224,255,0.8)'; }
        m.strokeRect(q.x, q.y, q.s, q.s);
        // No red frame around each panel. It drew a grid of red lines running
        // along the column axis - an axis you may not even be able to see - and
        // read as walls that were not there. The panel border above and the
        // highlighted panel you stand in are enough to show the slices.
        m.shadowBlur = 0;
        if (big) {
          m.font = txt(12);
          m.textAlign = 'right';
          if (mine) { m.fillStyle = 'rgba(53,224,255,0.9)'; m.fillText('YOU', q.x + q.s - 5, q.y + 12); }
          else if (holdsExit) { m.fillStyle = 'rgba(140,255,90,0.85)'; m.fillText('EXIT', q.x + q.s - 5, q.y + 12); }
          const n = MAPCACHE.counts ? MAPCACHE.counts[r * winCols + c] : 0;
          // The cell block is centered in the panel, so the slack above and below
          // it is the same. Both caption bands have to live in that bottom slack:
          // YOU/EXIT sit in the top band, these sit in the bottom one.
          if (n) {
            m.fillStyle = 'rgba(150,200,240,0.5)';
            m.fillText(n + ' found', q.x + q.s - 5, q.y + q.s - 3);
          }
          if (mine) {
            // the slice you are standing in, named by the axes actually in view
            m.fillStyle = 'rgba(53,224,255,0.75)';
            m.textAlign = 'left';
            m.fillText(`${rowName}${zz} / ${colName}${ww}`, q.x + 5, q.y + q.s - 3);
          }
          m.textAlign = 'left';
        }
      }
    }

    // passages
    const lk = MAPCACHE.links;
    for (let i = 0; i < lk.length; i += 5) {
      const col = lk[i + 4];
      m.strokeStyle = col === -1 ? 'rgba(130,205,240,0.26)'
        : col === -2 ? '#ff5a5a' : PALETTE[col].hex + '99';
      m.lineWidth = col === -2 ? 2 : 1;
      m.setLineDash([]);
      m.beginPath(); m.moveTo(lk[i], lk[i + 1]); m.lineTo(lk[i + 2], lk[i + 3]); m.stroke();
    }

    // rooms fill their whole cell, so the walls sit exactly on their edges
    const half = cs * 0.5;
    const cl = MAPCACHE.cells;
    for (let i = 0; i < cl.length; i += 4) {
      const x = cl[i], y = cl[i + 1], t = cl[i + 2];
      if (t === 0) {
        m.strokeStyle = 'rgba(130,190,230,0.18)';
        m.lineWidth = 1;
        m.strokeRect(x, y, cs, cs);
        continue;
      }
      m.fillStyle = t === 2 ? 'rgba(185,236,255,0.95)' : 'rgba(140,205,235,0.4)';
      m.fillRect(x, y, cs, cs);
    }

    // Solid edges, one stroke each. Red, because that is the wall color in the
    // game view, and each shared wall is emitted once so it is the same weight as
    // a wall on the outside rather than twice as thick. In colorblind mode the
    // wall dashes, which is the non-color cue that it is solid.
    const eg = MAPCACHE.edges;
    if (eg && eg.length) {
      m.strokeStyle = 'rgba(255,74,74,0.85)';
      m.lineWidth = cb ? cbLine(cs, 0.09) : Math.max(1, cs * 0.09);
      m.lineCap = 'butt';
      m.setLineDash(cb ? dashForWall() : []);
      m.beginPath();
      for (let i = 0; i < eg.length; i += 4) {
        m.moveTo(eg[i], eg[i + 1]);
        m.lineTo(eg[i + 2], eg[i + 3]);
      }
      m.stroke();
      m.setLineDash([]);
    }

    // No cap bar on the maps. With rooms filling their whole cell it landed
    // inside the room, right under your dot, where it read as a stray red line
    // rather than as a sealed end of the depth axis. A sealed end is shown in the
    // game view instead, by the red X or the seal.



    // doors, gates, ladders and locks inside rooms you have found
    const mk = MAPCACHE.marks;
    // Two rooms that share an edge both know about the passage between them, and
    // a gate that lands on a panel corner can be reached from more than one room,
    // so the same mark can arrive more than once. Stroking it twice puts two
    // identical marks on the same pixels, which is what made the colorblind
    // dash patterns look blurry. Draw each distinct mark once.
    const drawnMark = new Set();
    for (let i = 0; i < (mk ? mk.length : 0); i += 5) {
      const x = mk[i], y = mk[i + 1], kind = mk[i + 2], orient = mk[i + 4];
      const mkKey = x + '|' + y + '|' + kind + '|' + mk[i + 3];
      if (drawnMark.has(mkKey)) continue;
      drawnMark.add(mkKey);
      const c = PALETTE[mk[i + 3]];
      const u = Math.max(1.6, cs * 0.2);
      // glow is what smears a dash; in colorblind mode every stroke is a whole
      // number of pixels wide with butt caps, so the pattern stays sharp
      m.save();
      m.strokeStyle = c.hex;
      m.fillStyle = c.hex;
      m.lineCap = cb ? 'butt' : 'round';
      m.lineJoin = cb ? 'miter' : 'round';
      m.setLineDash([]);
      m.shadowBlur = cb ? CB_SHADOW : (big ? 8 : 4);
      m.shadowColor = c.hex;
      if (kind === 3) {                       // padlock
        m.translate(x, y);
        const s = u / 5;
        m.scale(s, s);
        m.lineWidth = cb ? Math.max(1.6, 1.6 / s) : 1.6;
        m.beginPath(); m.arc(0, -3.2, 3, Math.PI, 0); m.stroke();
        m.beginPath(); m.rect(-4.4, -1, 8.8, 6.8); m.fill();
        m.fillStyle = '#0a0a0c';
        m.beginPath(); m.arc(0, 1.5, 1, 0, Math.PI * 2); m.fill();
      } else if (kind === 2) {                // ladder / gate on the depth axis
        m.lineWidth = cb ? cbLine(cs, 0.1) : Math.max(1, u * 0.5);
        if (cb) m.setLineDash(dashFor(mk[i + 3]));
        m.beginPath();
        m.moveTo(x - u, y - u * 0.6); m.lineTo(x + u, y - u * 0.6);
        m.moveTo(x - u * 0.7, y); m.lineTo(x + u * 0.7, y);
        m.moveTo(x - u * 0.4, y + u * 0.6); m.lineTo(x + u * 0.4, y + u * 0.6);
        m.stroke();
      } else {                                // door / gate on an in-plane edge
        m.lineWidth = cb ? cbLine(cs, 0.16) : Math.max(1.5, cs * 0.16);
        if (cb) m.setLineDash(dashFor(mk[i + 3]));
        m.beginPath();
        if (orient === 0) {                  // vertical edge, left / right of the room
          m.moveTo(x, y - cs * 0.34); m.lineTo(x, y + cs * 0.34);
        } else {                             // horizontal edge, top / bottom
          m.moveTo(x - cs * 0.34, y); m.lineTo(x + cs * 0.34, y);
        }
        m.stroke();
      }
      m.setLineDash([]);
      m.restore();
    }

    // keys still in the lattice - drawn as actual keys, found or not
    const ky = MAPCACHE.keys;
    for (let i = 0; i < ky.length; i += 3) {
      const c = PALETTE[ky[i + 2]];
      const x = ky[i], y = ky[i + 1], u = Math.max(1, cs * 0.16);
      m.save();
      m.translate(x - u * 1.2, y);
      const ks = u / 3.1;
      m.scale(ks, ks);
      m.strokeStyle = c.hex;
      m.lineWidth = cb ? Math.max(1.6, 1.6 / ks) : 1.6;
      m.lineCap = cb ? 'butt' : 'round';
      m.shadowBlur = cb ? CB_SHADOW : (big ? 8 : 4);
      m.shadowColor = c.hex;
      m.beginPath(); m.arc(-4, 0, 3.1, 0, Math.PI * 2); m.stroke();
      m.beginPath();
      m.moveTo(-1, 0); m.lineTo(6.5, 0);
      m.moveTo(3, 0); m.lineTo(3, 3);
      m.moveTo(5.6, 0); m.lineTo(5.6, 3);
      m.stroke();
      m.restore();
    }

    // exit, always
    if (MAPCACHE.exit) {
      const p = MAPCACHE.exit;
      const found = !!G.visited[G.exit];
      m.fillStyle = found ? 'rgba(140,255,90,0.95)' : 'rgba(140,255,90,0.4)';
      m.fillRect(p.x - half * 0.6, p.y - half * 0.6, half * 1.2, half * 1.2);
      m.strokeStyle = '#8cff5a';
      m.lineWidth = big ? 1.5 : 1.1;
      m.shadowBlur = cb ? CB_SHADOW : (found ? 10 : 4);
      m.shadowColor = '#8cff5a';
      m.beginPath(); m.arc(p.x, p.y, cs * 0.55, 0, Math.PI * 2); m.stroke();
      if (!found) {
        m.globalAlpha = 0.3 + 0.3 * (0.5 + 0.5 * Math.sin(performance.now() / 420));
        m.beginPath(); m.arc(p.x, p.y, cs * 0.8, 0, Math.PI * 2); m.stroke();
        m.globalAlpha = 1;
      }
      m.shadowBlur = 0;
    }

    // last three moves
    const hist = G.history;
    for (let k = 0; k < hist.length; k++) {
      const co = hist[k];
      if (co[L.pageAx] !== L.vShown) continue;
      if (co[dAx] < z0 || co[dAx] >= z0 + winRows || co[sIdx] < w0 || co[sIdx] >= w0 + winCols) continue;
      const p = at(co);
      const age = hist.length - k;
      m.strokeStyle = `rgba(255,176,58,${(big ? [0.9, 0.55, 0.3] : [0.75, 0.45, 0.25])[age - 1]})`;
      m.lineWidth = cb ? 2 : (big ? 1.3 : 1);
      m.beginPath(); m.arc(p.x, p.y, cs * (0.34 + age * 0.13), 0, Math.PI * 2); m.stroke();
    }

    // you - dot size is on its own control ( , and . ) so you can find yourself
    // in a dense lattice without zooming the whole map away
    {
      const p = at(here);
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
      const k = Math.max(0.6, G.playerScale);
      const core = Math.max(2, cs * (0.26 + 0.07 * pulse) * k);
      const ring = Math.max(3.5, cs * (0.6 + pulse * 0.16) * k);
      m.fillStyle = PALETTE[G.color].hex;
      m.shadowBlur = cb ? CB_SHADOW : 10 + 8 * k;
      m.shadowColor = PALETTE[G.color].hex;
      m.beginPath(); m.arc(p.x, p.y, core, 0, Math.PI * 2); m.fill();
      m.shadowBlur = 0;
      m.strokeStyle = 'rgba(234,247,255,0.9)';
      m.lineWidth = cb ? Math.max(2, Math.round((big ? 1.2 : 1) * Math.min(2.4, k)))
                       : (big ? 1.2 : 1) * Math.min(2.4, k);
      m.beginPath(); m.arc(p.x, p.y, ring, 0, Math.PI * 2); m.stroke();
      if (k >= 1.5) {                       // crosshair once the dot is big
        m.strokeStyle = 'rgba(234,247,255,0.55)';
        m.lineWidth = 1;
        m.beginPath();
        m.moveTo(p.x - ring * 1.7, p.y); m.lineTo(p.x - ring * 1.15, p.y);
        m.moveTo(p.x + ring * 1.15, p.y); m.lineTo(p.x + ring * 1.7, p.y);
        m.moveTo(p.x, p.y - ring * 1.7); m.lineTo(p.x, p.y - ring * 1.15);
        m.moveTo(p.x, p.y + ring * 1.15); m.lineTo(p.x, p.y + ring * 1.7);
        m.stroke();
      }
    }
    m.restore();
  }

  function drawMinimap() { renderMap(mctx, mini.width, mini.height, false, G.mapZoom); }

  // The header has to name the axes the map is actually showing, which change
  // with the plane and depth axis you pick.
  function fullMapSub() {
    const p = planeAxes(), ax = mapAxis();
    const planeName = `${AXIS_NAME[p[0]]}/${AXIS_NAME[p[1]]}`;
    // The frame never moves: Z down the side, W across, V paged.
    let t = `each panel is a ${planeName} plane · rows are ${AXIS_NAME[ax.d]} slices · `
          + `columns are ${AXIS_NAME[ax.s]} slices`;
    t += ` · <kbd>[</kbd> <kbd>]</kbd> page ${AXIS_NAME[ax.v]}`;
    return t;
  }

  function drawFullMap() {
    if (!G.fullMap) return;
    // Measure the canvas, not the window. The canvas is inset from the viewport,
    // so laying out against window.innerWidth/innerHeight made every pad and
    // offset slightly too large and pushed the outer rows and columns off screen.
    const cw = full.clientWidth || W, ch = full.clientHeight || H;
    // The fullmap context is already scaled to CSS pixels, so the layout must be
    // measured in CSS pixels too. Handing it the device-pixel backing store size
    // made every pad and offset DPR times too big, which is why the panel you
    // stand in never lined up with the middle of the screen.
    // Fill the subtitle BEFORE laying out. The header's height is measured to work
    // out how much room the grid gets, and the subtitle is part of that header, so
    // rendering first drew one frame against an empty header and then snapped
    // smaller once the text landed - a visible jump in scale the moment you opened
    // the map.
    const sub0 = $('fullmap-sub');
    if (sub0) {
      const t0 = fullMapSub();
      if (sub0.dataset.t !== t0) { sub0.innerHTML = t0; sub0.dataset.t = t0; }
    }
    renderMap(fctx, cw, ch, true, G.mapZoom);
    const sub = $('fullmap-sub');
    if (sub) {
      const t = fullMapSub();
      if (sub.dataset.t !== t) { sub.innerHTML = t; sub.dataset.t = t; }
    }
    let found = 0, sensed = 0, keys = 0, vSeen = 0;
    const pa = LASTL ? LASTL.pageAx : scrollAxis();
    const vs = LASTL ? LASTL.vShown : G.player.c[pa];
    for (let i = 0; i < SIZE; i++) {
      if (G.visited[i]) found++;
      else if (G.sensed[i]) sensed++;
      if (G.keyAt[i] >= 0 && !G.keyGone[i]) keys++;
      if (G.visited[i] && coordOf(i)[pa] === vs) vSeen++;
    }
    // Name the V slice on screen, which is the thing [ ] actually changes, plus
    // the Z and W windows so you can see which part of the lattice you are looking
    // at. Both windows are clamped to real slices, so nothing here can read -1.
    // An unexplored V slice is legitimately blank, so say so rather than let it
    // look like the map failed to draw.
    const rng = (ax, z0, n) => `${AXIS_NAME[ax]} ${Math.max(0, z0)}..${Math.min(DIMS[ax] - 1, z0 + n - 1)}`;
    const where = LASTL
      ? `${AXIS_NAME[pa]} ${vs} of 0..${DIMS[pa] - 1}`
        + (vSeen ? '' : ' (not explored yet)')
        + ` · ${rng(LASTL.dAx, LASTL.z0, LASTL.winRows)}`
        + ` · ${rng(LASTL.sIdx, LASTL.w0, LASTL.winCols)}`
      : `${AXIS_NAME[pa]} ${vs}`;
    document.getElementById('fullmap-stats').textContent =
      `${DIMS.join('x')} ${CFG.mode} · ${found}/${SIZE} rooms found · ${sensed} sensed · ` +
      `${keys} keys left · holding ${G.keys.length} · ` +
      `${where}` +
      ` · exit ${G.visited[G.exit] ? 'found' : 'not found'}`;
    document.getElementById('map-zoom-label').textContent = Math.round(G.mapZoom * 100) + '%';
  }

  /* ---------------------------------------------------------
     10. LOOP
     --------------------------------------------------------- */
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!G.done) G.time += dt;
    if (Audio_.master) {
      const target = 0.32 + 0.28 * (1 / (1 + depthAxisVal()));
      Audio_.master.gain.value += (target - Audio_.master.gain.value) * 0.02;
    }
    draw();
    if (G.fullMap) drawFullMap();
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------
     11. MENU / CONFIG UI
     --------------------------------------------------------- */
  const $ = id => document.getElementById(id);

  function buildSetup() {
    const grid = $('size-grid');
    grid.innerHTML = '';
    AXIS_NAME.forEach((ax, i) => {
      const row = document.createElement('div');
      row.className = 'stepper';
      row.innerHTML =
        `<span class="stepper-axis">${ax}</span>` +
        `<button data-axis="${i}" data-d="-1">-</button>` +
        `<span class="stepper-val" id="dim-${i}">0</span>` +
        `<button data-axis="${i}" data-d="1">+</button>`;
      grid.appendChild(row);
    });
    grid.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = +b.dataset.axis, d = +b.dataset.d;
      // MIN_AXIS is 2 on every axis: a 1-deep axis has no inside, so the whole
      // lattice would collapse to a single room and there would be no maze
      CFG.dims[a] = clamp(CFG.dims[a] + d, MIN_AXIS, maxAxis());
      refreshSetup();
    });

    // how many signature colors the gates draw from. 0 means no gates at all
    const gc = $('gc-seg');
    gc.innerHTML = '';
    for (let n = 0; n <= PALETTE.length; n++) {
      const b = document.createElement('button');
      b.dataset.gc = n;
      b.textContent = n;
      b.title = n === 0 ? 'no gates - open lattice' : `${n} gate color${n > 1 ? 's' : ''}`;
      gc.appendChild(b);
    }
    gc.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      CFG.gateColors = +b.dataset.gc;
      refreshSetup();
    });

    const rd = $('rd-seg');
    rd.innerHTML = '';
    [1, 2, 3, 4, 6].forEach(n => {
      const b = document.createElement('button');
      b.dataset.rd = n;
      b.textContent = n;
      rd.appendChild(b);
    });
    rd.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      CFG.renderDist = +b.dataset.rd;
      refreshSetup();
    });

    $('mode-seg').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      CFG.mode = b.dataset.mode;
      refreshSetup();
    });
  }

  function refreshSetup() {
    const mx = maxAxis();
    AXIS_NAME.forEach((ax, i) => {
      const v = $('dim-' + i);
      if (v) v.textContent = CFG.dims[i];
      const row = v && v.parentElement;
      if (row) {
        row.classList.toggle('maxed', CFG.dims[i] >= mx);
        row.classList.toggle('minned', CFG.dims[i] <= MIN_AXIS);
      }
    });
    const fit = fitDims(CFG.dims);
    $('setup-note').innerHTML =
      `<b>${fit.cells.toLocaleString()}</b> rooms` +
      (fit.trimmed ? ` · depth axes trimmed to <b>${fit.dims.join('x')}</b>` : '') +
      `<br>axis size <b>${MIN_AXIS}</b> to <b>${mx}</b>` +
      (CFG.gateColors === 0
        ? ' · <b>no gate colors</b>, every passage is open'
        : ` · <b>${CFG.gateColors}</b> gate color${CFG.gateColors > 1 ? 's' : ''}`) +
      (bigUnlocked() ? ' · big lattices unlocked' : ` · unlock at ${WINS_TO_UNLOCK} wins in each mode`);
    $('setup-progress').textContent =
      `regular ${PROGRESS.regularWins}/${WINS_TO_UNLOCK} cleared · ` +
      `lockdown ${PROGRESS.lockdownWins}/${WINS_TO_UNLOCK} cleared`;
    document.querySelectorAll('#mode-seg button').forEach(b =>
      b.classList.toggle('on', b.dataset.mode === CFG.mode));
    document.querySelectorAll('#rd-seg button').forEach(b =>
      b.classList.toggle('on', +b.dataset.rd === CFG.renderDist));
    document.querySelectorAll('#gc-seg button').forEach(b =>
      b.classList.toggle('on', +b.dataset.gc === CFG.gateColors));
    const sw = $('gc-swatches');
    if (sw) sw.innerHTML = PALETTE.slice(0, CFG.gateColors)
      .map(c => `<i style="background:${c.hex}"></i>`).join('');
    const gateNote = CFG.gateColors === 0
      ? ' No gates at all: every passage is open, so this is a pure maze run.'
      : ` Gates use the first ${CFG.gateColors} signature color${CFG.gateColors > 1 ? 's' : ''}, and there is a pad for each one.`;
    $('mode-blurb').textContent = (CFG.mode === 'lockdown'
      ? 'Lockdown: the lattice is chained with locks. Each lock needs a key of its color, and every key sits on the root side of its own lock, so you can always reach the key before the lock that needs it.'
      : 'Regular: signature gates only. Match your color to a door, ladder or axis gate to pass. Nothing is chained.') + gateNote;
  }

  function clampCfg() {
    const mx = maxAxis();
    CFG.dims = CFG.dims.map(d => clamp(d | 0, MIN_AXIS, mx));
    CFG.renderDist = clamp(CFG.renderDist, 1, 6);
    CFG.gateColors = clamp(CFG.gateColors | 0, 0, PALETTE.length);
  }

  /* ---------------------------------------------------------
     12. INPUT
     --------------------------------------------------------- */
  // Shift pressed with nothing else held down steps down the depth axis. Held
  // with another key it stays a modifier, so Shift+Tab and Shift+V still work.
  const HELD = new Set();
  const SHIFT_CODES = ['ShiftLeft', 'ShiftRight'];
  function shiftAlone(e) {
    if (!e.shiftKey) return false;
    for (const code of HELD) if (!SHIFT_CODES.includes(code)) return false;
    return true;
  }
  function trackKey(e, down) {
    if (SHIFT_CODES.includes(e.code)) {
      if (down) {
        HELD.add(e.code);
        // never move while a menu is up, same as every other binding
        if (!pageUp() && shiftAlone(e)) tryMove(depthAxis(), -1);
      } else HELD.delete(e.code);
      return;
    }
    if (down) HELD.add(e.code); else HELD.delete(e.code);
  }

  window.addEventListener('keydown', e => {
    trackKey(e, true);
    if (['Tab', 'Space'].includes(e.code)) e.preventDefault();



    const overlayUp = $('overlay').classList.contains('show');
    const winUp = $('win').classList.contains('show');

    // Enter (and plain Space) start a run, but only while a menu is up. During
    // play Space belongs to the depth axis, so this must NOT swallow it.
    if (overlayUp || winUp) {
      if (e.code === 'Enter' || e.code === 'Space') {
        if (overlayUp) start(); else newRun();
        return;
      }
      return;
    }
    if (e.code === 'Escape' && G.fullMap) { toggleFullMap(); return; }
    if (overlayUp || winUp) return;

    const p = planeAxes();
    switch (e.code) {
      case 'KeyW': tryMove(p[1], -1); break;
      case 'KeyS': tryMove(p[1], +1); break;
      case 'KeyA': tryMove(p[0], -1); break;
      case 'KeyD': tryMove(p[0], +1); break;
      // Space steps up the depth axis. Shift on its own steps down it, but only
      // when it is pressed by itself - holding Shift for another key (Tab, R,
      // and so on) must not also move you.
      case 'Space': tryMove(depthAxis(), +1); break;
      case 'KeyR': setColor(G.color + 1); break;      // resonate
      case 'KeyX': cycleDepth(+1); break;            // cycle the depth axis
      case 'Tab': cyclePlane(e.shiftKey ? -1 : +1); break;
      case 'KeyV': toggleCB(); break;
      case 'KeyM': toggleFullMap(); break;
      case 'KeyN': toggleMini(); break;
      case 'BracketLeft': G.mapPage = clampPage(G.mapPage - 1); G.mapDirty = true; G.rev++; break;
      case 'BracketRight': G.mapPage = clampPage(G.mapPage + 1); G.mapDirty = true; G.rev++; break;
      case 'Equal': case 'NumpadAdd': zoomMap(+1); break;
      case 'Minus': case 'NumpadSubtract': zoomMap(-1); break;
      case 'Digit0': zoomMap(0); break;
      case 'Comma': scalePlayer(-1); break;
      case 'Period': scalePlayer(+1); break;
      case 'KeyC': resetCamera(); break;
    }
  });

  // a key released anywhere stops counting as held, so a window that loses
  // focus mid-chord cannot leave Shift stuck down
  window.addEventListener('keyup', e => trackKey(e, false));
  window.addEventListener('blur', () => HELD.clear());

  // C puts the camera back to the isometric the game starts in
  function resetCamera() {
    G.yawT = YAW0; G.pitchT = PITCH0;
    G.viewZoom = 1;
    toast('CAMERA RESET TO ISOMETRIC', 'axis');
  }

  const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3, 4];
  function zoomMap(dir) {
    if (dir === 0) G.mapZoom = 1;
    else {
      let i = ZOOMS.indexOf(G.mapZoom);
      if (i < 0) i = ZOOMS.indexOf(1);
      G.mapZoom = ZOOMS[clamp(i + dir, 0, ZOOMS.length - 1)];
    }
    document.getElementById('map-zoom-label').textContent = Math.round(G.mapZoom * 100) + '%';
  }

  // the player marker gets its own size on the maps, so a crowded lattice stays readable
  const PSCALES = [0.75, 1, 1.5, 2.25, 3.5];
  function scalePlayer(dir) {
    let i = PSCALES.indexOf(G.playerScale);
    if (i < 0) i = 1;
    G.playerScale = PSCALES[clamp(i + dir, 0, PSCALES.length - 1)];
    G.mapDirty = true;
    syncDotLabel();
    toast(`PLAYER DOT ${G.playerScale}×`, 'axis');
  }

  // left-drag orbits the camera: horizontal turns the lattice, vertical tips it
  // out of isometric. pointer capture keeps the drag alive outside the canvas.
  let drag = null;
  cvs.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (document.getElementById('overlay').classList.contains('show')) return;
    if (document.getElementById('win').classList.contains('show')) return;
    drag = { x: e.clientX, y: e.clientY, yaw: G.yawT, pitch: G.pitchT, moved: 0 };
    cvs.setPointerCapture(e.pointerId);
    cvs.style.cursor = 'grabbing';
  });
  cvs.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
    // Grab-and-drag: the lattice follows the pointer. Sideways, the near face
    // swings the way you pull (so yaw takes the opposite sign of dx). Downward,
    // you pull the top of the slice stack toward you, which tips the view over
    // into top-down, so pitch takes the same sign as dy.
    G.yawT = drag.yaw - dx * YAW_DRAG;
    G.pitchT = clamp(drag.pitch + dy * PITCH_DRAG, PITCH_MIN, PITCH_MAX);
  });
  function endDrag(e) {
    if (!drag) return;
    drag = null;
    cvs.style.cursor = '';
    try { cvs.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  cvs.addEventListener('pointerup', endDrag);
  cvs.addEventListener('pointercancel', endDrag);
  cvs.addEventListener('lostpointercapture', () => { drag = null; cvs.style.cursor = ''; });

  // the wheel zooms the game view only - the maps keep their own +/- zoom
  window.addEventListener('wheel', e => {
    if (document.getElementById('overlay').classList.contains('show')) return;
    if (G.fullMap) return;
    e.preventDefault();
    G.viewZoom = clamp(G.viewZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.45, 3);
  }, { passive: false });

  function toggleCB() {
    G.colorblind = !G.colorblind;
    document.body.classList.toggle('cb', G.colorblind);
    toast(G.colorblind ? 'COLORBLIND PATTERNS ON' : 'COLORBLIND PATTERNS OFF', 'axis');
  }
  function toggleFullMap() {
    G.fullMap = !G.fullMap;
    $('fullmap').classList.toggle('show', G.fullMap);
    document.body.classList.toggle('fullmap-open', G.fullMap);
    document.querySelector('#buttonbar button[data-act="map"]').classList.toggle('on', G.fullMap);
    // the toast element is shared between the game view and the full map, so
    // drop whatever is fading out before the page changes
    hideToast();
    if (G.fullMap) {
      sizeFullMap();
      const p = planeAxes();
      toast(`LATTICE MAP · ${AXIS_NAME[p[0]]}/${AXIS_NAME[p[1]]} PLANES · ${AXIS_NAME[depthAxis()]} SLICES`, 'axis');
    }
  }
  function toggleMini() {
    G.showMap = !G.showMap;
    $('minimap').style.display = G.showMap ? '' : 'none';
    $('minimap-legend').style.display = G.showMap ? '' : 'none';
    document.querySelector('#buttonbar button[data-act="mini"]').classList.toggle('on', !G.showMap);
  }

  $('buttonbar').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'plane') cyclePlane(+1);
    if (act === 'depth') cycleDepth(+1);
    if (act === 'color') setColor(G.color + 1);
    if (act === 'cb') { toggleCB(); b.classList.toggle('on', G.colorblind); }
    if (act === 'map') toggleFullMap();
    if (act === 'mini') toggleMini();
    if (act === 'reset') newRun();
  });

  document.querySelectorAll('.zoom-bar').forEach(bar => {
    bar.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.zoom !== undefined) zoomMap(+b.dataset.zoom);
      else if (b.dataset.dot !== undefined) scalePlayer(+b.dataset.dot);
    });
  });

  function syncDotLabel() {
    const el = $('dot-label');
    if (el) el.textContent = `dot ${G.playerScale}×`;
  }

  $('start-btn').addEventListener('click', start);  $('again-btn').addEventListener('click', () => newRun());
  $('config-btn').addEventListener('click', () => {
    $('win').classList.remove('show');
    $('overlay').classList.add('show');
    hideToast(); syncToastPage();
    if (G.fullMap) toggleFullMap();     // never leave the full map open behind the menu
    refreshSetup();
  });

  function start() {
    clampCfg();
    $('overlay').classList.remove('show');
    $('win').classList.remove('show');
    hideToast(); syncToastPage();
    G.menuUp = false;
    generate((Math.random() * 0xffffffff) >>> 0);
    setColor(0, true);
    G.mapDirty = true;
    updateHUD();
    draw();          // paint the new lattice straight away, no waiting on the next frame
    audioInit();
    if (Audio_.ctx && Audio_.ctx.state === 'suspended') Audio_.ctx.resume();
    toast(`${CFG.mode.toUpperCase()} · ${DIMS.join('x')} · ${G.locks} LOCKS`, 'axis');
  }

  /* ---------------------------------------------------------
     13. BOOT
     --------------------------------------------------------- */
  loadProgress();
  clampCfg();
  resize();
  buildSetup();
  refreshSetup();
  paintSealLegend();
  generate((Math.random() * 0xffffffff) >>> 0);
  setColor(0, true);
  updateHUD();
  const best = store.get('penteraction.best');
  if (best) {
    const s = Number(best);
    $('best-time').textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  if (location.hash === '#debug') {
    window.__PA = { G, KIND, PALETTE, MAX_CELLS, WINS_TO_UNLOCK, zoomMap, scalePlayer, drawFullMap,
    BAS: () => BAS, CORN: () => CORN, linkOnSkin, roomOnSkin, resetCamera,
    cellScreen, fitFactor: () => FIT,
    MIN_AXIS, tintedEmoji, SEAL_EMOJI, spareAxis, mapAxis, cbMapLine: cbLine, toast, syncToastPage,
    mapCache: () => CACHES,
    edgeStats: () => ({ queued: EDGE_STATS.queued, deduped: EDGE_STATS.deduped }),
    mapCacheReset: () => { CACHES.mini.key = ''; CACHES.full.key = ''; },
    dashFor, shapeFor, CBLineWidth: cbWidth, cbShadow: () => CB_SHADOW, get DIMS() { return DIMS; }, get SIZE() { return SIZE; }, idxOf, coordOf, inBounds, PLANE_PAIRS, LK, tryMove, depthAxis, planeAxes, refreshSetup, CFG, PROGRESS, start, newRun, bigUnlocked, maxAxis, draw, renderMap, mapLayout, get full() { return full; }, get fctx() { return fctx; }, get mini() { return mini; }, get mctx() { return mctx; } };
  }
  requestAnimationFrame(frame);
})();
