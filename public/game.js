/* Hopper: Garden Crossing - game loop, networking and UI. */
"use strict";

const $ = (s) => document.querySelector(s);
const cv = $("#cv");
const ctx = cv.getContext("2d");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- state ---------- */

let S = 40;
let dpr = 1;
const bgCache = {};

const profile = { name: "", color: 0 };
try {
  profile.name = localStorage.getItem("hopper.name") || "";
  profile.color = clamp(parseInt(localStorage.getItem("hopper.color") || "0", 10) || 0, 0, 7);
} catch (e) {}

const G = {
  mode: "menu", // menu | solo | online
  phase: "demo", // demo | countdown | race | over
  loc: 0,
  seed: 1,
  round: 1,
  startAt: 0,
  traffic: [],
  laneByRow: {},
  demoLoc: -1,
};

const L = {
  x: 4, y: 9, fx: 4, fy: 9,
  t0: 0, dur: 120, ang: 0,
  lives: 3, status: "idle", // idle | racing | finished | out
  invuln: 0, dead: false, respawn: 0, time: 0,
};

const net = { ws: null, id: 0, offset: 0, rtt: 1e9, room: "", players: new Map(), phase: "lobby", syncTimer: 0 };
const splats = [];
let goUntil = 0;
let lastTick = -1;
let lastLives = -1;
let resultsTimer = 0;
const solo = { round: 1, loc: 0 };

const now = () => Date.now() + (G.mode === "online" ? net.offset : 0);

/* ---------- audio ---------- */

let actx = null;
let soundOn = true;
function ac() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (actx && actx.state === "suspended") actx.resume();
  return actx;
}
function tone(f, d, type, vol, slide, delay) {
  if (!soundOn) return;
  const a = ac();
  if (!a) return;
  const t = a.currentTime + (delay || 0);
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type || "square";
  o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.linearRampToValueAtTime(Math.max(30, f + slide), t + d);
  g.gain.setValueAtTime(vol || 0.05, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + d + 0.02);
}
function noise(d, vol) {
  if (!soundOn) return;
  const a = ac();
  if (!a) return;
  const n = Math.floor(a.sampleRate * d);
  const buf = a.createBuffer(1, n, a.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = a.createBufferSource();
  const g = a.createGain();
  g.gain.value = vol;
  s.buffer = buf;
  s.connect(g).connect(a.destination);
  s.start();
}
const sfx = {
  hop: () => tone(280, 0.08, "square", 0.04, 260),
  die: () => { noise(0.28, 0.16); tone(180, 0.28, "sawtooth", 0.06, -130); },
  tick: () => tone(620, 0.09, "square", 0.05),
  go: () => tone(1040, 0.3, "square", 0.07),
  win: () => [520, 660, 780, 1040].forEach((f, i) => tone(f, 0.16, "square", 0.06, 0, i * 0.11)),
  out: () => [300, 240, 180].forEach((f, i) => tone(f, 0.18, "sawtooth", 0.06, 0, i * 0.14)),
};

/* ---------- layout ---------- */

function resize() {
  const st = $("#stage");
  const w = st.clientWidth;
  const h = st.clientHeight;
  dpr = Math.min(3, window.devicePixelRatio || 1);
  S = Math.max(24, Math.floor(Math.min(w / COLS, h / ROWS)));
  cv.style.width = S * COLS + "px";
  cv.style.height = S * ROWS + "px";
  cv.width = Math.round(S * COLS * dpr);
  cv.height = Math.round(S * ROWS * dpr);
  for (const k in bgCache) delete bgCache[k];
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 120));

function bg(li) {
  const key = li + ":" + S + ":" + dpr;
  if (!bgCache[key]) bgCache[key] = buildBG(li, S, dpr);
  return bgCache[key];
}

/* ---------- rounds ---------- */

function setTraffic(li, seed, round) {
  G.traffic = buildTraffic(li, seed, round);
  G.laneByRow = {};
  for (const l of G.traffic) G.laneByRow[l.row] = l;
}

function resetLocal(status) {
  L.x = 4; L.y = 9; L.fx = 4; L.fy = 9;
  L.t0 = -1000; L.ang = 0;
  L.lives = 3; L.status = status;
  L.invuln = 0; L.dead = false; L.time = 0;
}

function startRound(info, participate) {
  G.loc = info.loc;
  G.seed = info.seed;
  G.round = info.round;
  G.startAt = info.startAt;
  setTraffic(info.loc, info.seed, info.round);
  G.phase = now() < info.startAt ? "countdown" : "race";
  resetLocal(participate ? "racing" : "idle");
  lastTick = -1;
  goUntil = 0;
  lastLives = -1;
  splats.length = 0;
  hideScreens();
  $("#locName").textContent = LOCS[info.loc % LOCS.length].name;
  $("#roundTag").textContent =
    G.mode === "online" ? "ROOM " + net.room + " · ROUND " + info.round : "SOLO RUN " + info.round;
}

function hideScreens() {
  for (const id of ["menu", "lobby", "results"]) $("#" + id).hidden = true;
}
function showScreen(id) {
  for (const s of ["menu", "lobby", "results"]) $("#" + s).hidden = s !== id;
}

/* ---------- hopping ---------- */

function vis() {
  const ms = performance.now();
  const u = clamp((ms - L.t0) / L.dur, 0, 1);
  const e = u * u * (3 - 2 * u);
  return { x: L.fx + (L.x - L.fx) * e, y: L.fy + (L.y - L.fy) * e, u };
}

function hop(dx, dy) {
  if (G.phase !== "race" || L.status !== "racing" || L.dead) return;
  const ms = performance.now();
  if (ms - L.t0 < 85) return;
  const nx = clamp(L.x + dx, 0, COLS - 1);
  const ny = clamp(L.y + dy, 0, ROWS - 1);
  if (nx === L.x && ny === L.y) return;
  const v = vis();
  L.fx = v.x; L.fy = v.y;
  L.x = nx; L.y = ny;
  L.t0 = ms;
  L.ang = dx > 0 ? Math.PI / 2 : dx < 0 ? -Math.PI / 2 : dy > 0 ? Math.PI : 0;
  sfx.hop();
  sendPos(false);
  if (ny === 0) finishRace();
}

function sendPos(dead) {
  netSend({ t: "pos", x: L.x, y: L.y, l: L.lives, d: dead ? 1 : 0 });
}

function finishRace() {
  L.status = "finished";
  L.time = now() - G.startAt;
  sfx.win();
  petals(L.x * S + S / 2, S * 0.5);
  netSend({ t: "finish" });
  navigator.vibrate && navigator.vibrate([20, 40, 20]);
  if (G.mode === "solo") endSolo(true);
}

function die() {
  const v = vis();
  L.lives -= 1;
  L.dead = true;
  L.respawn = performance.now() + 720;
  splat(v.x * S + S / 2, v.y * S + S / 2, "#6fb83a");
  sfx.die();
  navigator.vibrate && navigator.vibrate(60);
  sendPos(true);
  if (L.lives <= 0) {
    L.status = "out";
    netSend({ t: "out" });
    setTimeout(sfx.out, 300);
    if (G.mode === "solo") setTimeout(() => endSolo(false), 900);
  }
}

function splat(px, py, col) {
  const parts = [];
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2;
    parts.push({ a, d: 0.3 + Math.random() * 0.9, s: 0.05 + Math.random() * 0.07 });
  }
  splats.push({ x: px, y: py, t0: performance.now(), col, parts, life: 720 });
}
function petals(px, py) {
  const parts = [];
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    parts.push({ a, d: 0.6 + Math.random() * 1.8, s: 0.06 + Math.random() * 0.06 });
  }
  splats.push({ x: px, y: py, t0: performance.now(), col: "#ffc21a", parts, life: 1100, petal: true });
}

/* ---------- solo ---------- */

function startSolo(li, round) {
  closeNet(true);
  G.mode = "solo";
  solo.loc = li;
  solo.round = round || 1;
  startRound(
    { loc: li, seed: (Math.random() * 2 ** 31) | 0, round: solo.round, startAt: Date.now() + 3500 },
    true
  );
}

function endSolo(won) {
  G.phase = "over";
  const rows = [
    {
      id: 1, name: profile.name || "HOPPER", color: profile.color,
      status: won ? "finished" : "out", time: L.time, points: won ? 1000 + L.lives * 50 : 0, total: 0, place: 1,
      me: true,
    },
  ];
  clearTimeout(resultsTimer);
  resultsTimer = setTimeout(() => {
    renderResults(rows, true, won);
    showScreen("results");
  }, 900);
}

/* ---------- networking ---------- */

function wsUrl(code) {
  return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws?room=" + encodeURIComponent(code);
}

function netSend(o) {
  if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(o));
}

function openSocket(code) {
  return new Promise((resolve, reject) => {
    if (location.protocol === "file:") return reject(new Error("offline"));
    let ws;
    try { ws = new WebSocket(wsUrl(code)); } catch (e) { return reject(new Error("socket")); }
    let done = false;
    const fail = (msg) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      try { ws.close(); } catch (e) {}
      reject(new Error(msg));
    };
    const to = setTimeout(() => fail("timeout"), 7000);
    ws.onopen = () => ws.send(JSON.stringify({ t: "join", name: profile.name || "HOPPER", color: profile.color }));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (done) return;
      if (m.t === "welcome") { done = true; clearTimeout(to); resolve({ ws, m }); }
      else if (m.t === "full") fail("full");
    };
    ws.onerror = () => fail("socket");
    ws.onclose = () => fail("closed");
  });
}

async function joinRoom(code) {
  closeNet(true);
  setBusy(true);
  try {
    const { ws, m } = await openSocket(code);
    net.ws = ws;
    net.id = m.id;
    net.room = code;
    net.rtt = 1e9;
    net.offset = m.now - Date.now();
    net.players = new Map();
    G.mode = "online";
    for (const p of m.room.players) addPlayer(p);
    ws.onmessage = (ev) => {
      try { onNet(JSON.parse(ev.data)); } catch (e) {}
    };
    ws.onclose = () => { if (net.ws === ws) lostConnection(); };
    ws.onerror = () => {};
    syncClock();
    clearInterval(net.syncTimer);
    net.syncTimer = setInterval(syncClock, 15000);
    net.phase = m.room.phase;
    $("#roomCode").textContent = code;
    showScreen("lobby");
    if (m.room.phase === "countdown" || m.room.phase === "race") {
      startRound(m.room, false);
      showScreen("lobby");
      $("#lobbyNote").textContent = "A race is on. Ready up to join the next one.";
    } else {
      $("#lobbyNote").textContent = "The race starts when every hopper is ready.";
    }
    renderRoster();
    return true;
  } catch (e) {
    return e.message || "socket";
  } finally {
    setBusy(false);
  }
}

function syncClock() {
  for (let i = 0; i < 5; i++) setTimeout(() => netSend({ t: "ping", c: Date.now() }), i * 220);
}

function closeNet(silent) {
  clearInterval(net.syncTimer);
  const ws = net.ws;
  net.ws = null;
  if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
  net.players = new Map();
  net.id = 0;
  if (!silent) goMenu();
}

function lostConnection() {
  closeNet(true);
  toast("CONNECTION LOST");
  goMenu();
}

function goMenu() {
  clearTimeout(resultsTimer);
  G.mode = "menu";
  G.phase = "demo";
  resetLocal("idle");
  lastLives = -1;
  splats.length = 0;
  G.demoLoc = -1;
  $("#locName").textContent = "HOPPER";
  $("#roundTag").textContent = "GARDEN CROSSING";
  $("#timer").textContent = "0.0";
  $("#posTag").innerHTML = "&nbsp;";
  $("#banner").textContent = "";
  showScreen("menu");
}

function addPlayer(p) {
  net.players.set(p.id, Object.assign({ gx: p.x, gy: p.y, flash: 0 }, p));
}

function onNet(m) {
  switch (m.t) {
    case "pong": {
      const t1 = Date.now();
      const rtt = t1 - m.c;
      if (rtt < net.rtt) { net.rtt = rtt; net.offset = m.s + rtt / 2 - t1; }
      break;
    }
    case "joined":
      addPlayer(m.p);
      toast(m.p.name + " JOINED");
      renderRoster();
      break;
    case "left": {
      const p = net.players.get(m.id);
      if (p) toast(p.name + " LEFT");
      net.players.delete(m.id);
      renderRoster();
      break;
    }
    case "ready": {
      const p = net.players.get(m.id);
      if (p) p.ready = m.v;
      renderRoster();
      updateReadyButtons();
      break;
    }
    case "start": {
      net.phase = "countdown";
      for (const p of net.players.values()) {
        p.status = "racing"; p.x = 4; p.y = 9; p.gx = 4; p.gy = 9; p.lives = 3; p.time = 0; p.ready = false;
      }
      clearTimeout(resultsTimer);
      if (m.now && net.rtt === 1e9) net.offset = m.now - Date.now();
      startRound(m, true);
      break;
    }
    case "pos": {
      const p = net.players.get(m.id);
      if (!p) break;
      p.x = m.x; p.y = m.y; p.lives = m.l;
      if (m.d) { splat(p.gx * S + S / 2, p.gy * S + S / 2, "#6fb83a"); p.flash = performance.now() + 700; }
      break;
    }
    case "fin": {
      const p = net.players.get(m.id);
      if (p) { p.status = "finished"; p.time = m.time; p.y = 0; }
      if (m.id === net.id) { L.time = m.time; }
      else { toast((p ? p.name : "RIVAL") + " CROSSED IN " + (m.time / 1000).toFixed(2) + "S"); }
      break;
    }
    case "out": {
      const p = net.players.get(m.id);
      if (p) p.status = "out";
      break;
    }
    case "results": {
      net.phase = "results";
      G.phase = "over";
      for (const r of m.results) {
        const p = net.players.get(r.id);
        if (p) { p.total = r.total; p.ready = false; }
      }
      const rows = m.results.map((r) => Object.assign({ me: r.id === net.id }, r));
      clearTimeout(resultsTimer);
      resultsTimer = setTimeout(() => {
        renderResults(rows, false, null);
        showScreen("results");
      }, 700);
      break;
    }
  }
}

/* ---------- DOM: roster, results, toast ---------- */

let toastTimer = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

function setBusy(b) {
  for (const id of ["btnQuick", "btnNew", "btnJoin", "btnSolo"]) $("#" + id).disabled = b;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderRoster() {
  const ul = $("#roster");
  ul.innerHTML = "";
  const list = [...net.players.values()];
  $("#lobbyCount").textContent = "(" + list.length + "/8)";
  for (const p of list) {
    const li = document.createElement("li");
    if (p.id === net.id) li.className = "me";
    li.innerHTML =
      '<span class="chip" style="background:' + PLAYER_COLORS[p.color % 8] + '"></span>' +
      '<span class="nm">' + esc(p.name) + (p.id === net.id ? " (YOU)" : "") + "</span>" +
      '<span class="tag ' + (p.ready ? "ok" : "") + '">' + (p.ready ? "READY" : "WAITING") + "</span>";
    ul.appendChild(li);
  }
  updateReadyButtons();
}

function updateReadyButtons() {
  const me = net.players.get(net.id);
  const ready = !!(me && me.ready);
  const b = $("#btnReady");
  b.textContent = ready ? "READY - TAP TO CANCEL" : "READY";
  b.classList.toggle("on", ready);
  if (G.mode === "online") {
    const n = $("#btnNext");
    n.textContent = ready ? "READY - TAP TO CANCEL" : "READY FOR NEXT";
    n.classList.toggle("on", ready);
  }
}

function fmtTime(ms) {
  return (ms / 1000).toFixed(2) + "s";
}

function renderResults(rows, isSolo, won) {
  const next = LOCS[(isSolo ? solo.round : G.round) % LOCS.length];
  $("#resTitle").textContent = isSolo ? "SOLO RUN" : "ROUND " + G.round + " RESULTS";
  $("#resHead").textContent = isSolo ? (won ? "ACROSS IN " + fmtTime(rows[0].time) : "RUN OVER") : LOCS[G.loc % LOCS.length].name;
  const ol = $("#resList");
  ol.innerHTML = "";
  for (const r of rows) {
    const li = document.createElement("li");
    if (r.me) li.className = "me";
    const tm = r.status === "finished" ? fmtTime(r.time) : r.status === "out" ? "OUT" : "DNF";
    li.innerHTML =
      '<span class="pl">' + r.place + "</span>" +
      '<span class="chip" style="background:' + PLAYER_COLORS[(r.color || 0) % 8] + '"></span>' +
      '<span class="nm">' + esc(r.name) + "</span>" +
      '<span class="tm">' + tm + "</span>" +
      '<span class="pt">' + (isSolo ? "+" + r.points : r.total + " (+" + r.points + ")") + "</span>";
    ol.appendChild(li);
  }
  if (isSolo) {
    $("#resNext").textContent = won ? "Next stop: " + next.short + ". Traffic gets faster each round." : "Three lives gone. Try this one again.";
    const n = $("#btnNext");
    n.textContent = won ? "NEXT LOCATION" : "TRY AGAIN";
    n.classList.remove("on");
    $("#btnResLeave").textContent = "MENU";
  } else {
    $("#resNext").textContent = "Next stop: " + next.short + ". Everyone ready starts the race.";
    $("#btnResLeave").textContent = "LEAVE";
    updateReadyButtons();
  }
}

/* ---------- ranking and HUD ---------- */

function standings() {
  const arr = [];
  for (const p of net.players.values()) {
    const meP = p.id === net.id;
    arr.push({
      id: p.id,
      st: meP ? L.status : p.status,
      y: meP ? L.y : p.y,
      time: meP ? L.time : p.time,
    });
  }
  const rank = (a) => (a.st === "finished" ? 0 : a.st === "racing" ? 1 : a.st === "out" ? 3 : 2);
  arr.sort((a, b) => rank(a) - rank(b) || (a.st === "finished" ? a.time - b.time : a.y - b.y));
  return arr;
}

function updateHud(t) {
  // timer
  let txt = "0.0";
  if (G.phase === "race" && L.status === "racing") txt = Math.max(0, t).toFixed(1);
  else if (L.status === "finished") txt = (L.time / 1000).toFixed(1);
  else if (G.phase === "race") txt = Math.max(0, t).toFixed(1);
  $("#timer").textContent = txt;

  // position
  let pos = " ";
  if (G.mode === "online" && (G.phase === "race" || G.phase === "countdown") && L.status !== "idle") {
    const st = standings();
    const i = st.findIndex((a) => a.id === net.id);
    if (i >= 0) pos = "POS " + (i + 1) + " / " + st.length;
  }
  $("#posTag").textContent = pos;

  // lives
  if (lastLives !== L.lives) {
    lastLives = L.lives;
    const el = $("#lives");
    el.innerHTML = "";
    for (let i = 0; i < 3; i++) {
      const p = document.createElement("i");
      if (i >= L.lives) p.className = "off";
      el.appendChild(p);
    }
  }

  // banner
  const b = $("#banner");
  let txtB = "";
  let small = false;
  let cls = "";
  const nowMs = now();
  if (G.phase === "countdown" || (G.phase === "race" && nowMs < G.startAt)) {
    const left = Math.ceil((G.startAt - nowMs) / 1000);
    if (left > 0 && left <= 3) {
      txtB = String(left);
      if (left !== lastTick) { lastTick = left; sfx.tick(); }
    } else if (left > 3) {
      txtB = "";
    }
  }
  if (G.phase === "race" && nowMs >= G.startAt && goUntil === 0) {
    goUntil = performance.now() + 700;
    sfx.go();
  }
  if (goUntil && performance.now() < goUntil && L.status === "racing") { txtB = "GO!"; cls = "go"; }
  if (!txtB && G.phase !== "demo" && screensHidden()) {
    if (L.status === "finished" && G.mode === "online") { txtB = "ACROSS IN " + fmtTime(L.time) + ". Watching the pack."; small = true; }
    else if (L.status === "out") { txtB = "OUT. Watching the pack."; small = true; }
    else if (L.status === "idle" && G.mode === "online" && G.phase !== "over") { txtB = "Race in progress. You are in the next one."; small = true; }
  }
  if (b.dataset.k !== txtB + cls + small) {
    b.dataset.k = txtB + cls + small;
    b.innerHTML = txtB ? '<span class="' + cls + '">' + esc(txtB) + "</span>" : "";
    b.classList.toggle("small", small);
  }
}

function screensHidden() {
  return $("#menu").hidden && $("#lobby").hidden && $("#results").hidden;
}

/* ---------- drawing ---------- */

function drawTraffic(t) {
  for (const lane of G.traffic) {
    const y = lane.row * S + S * 0.1;
    const H = S * 0.8;
    const W = lane.w * S;
    const draw = SP[lane.type];
    for (let k = 0; k < lane.base.length; k++) {
      const x = itemX(lane, k, t);
      if (x + lane.w < -0.2 || x > COLS + 0.2) continue;
      ctx.save();
      ctx.translate(x * S, y);
      if (lane.dir < 0) { ctx.translate(W, 0); ctx.scale(-1, 1); }
      ctx.fillStyle = "rgba(0,0,0,.28)";
      ell(ctx, W * 0.5, H * 0.92, W * 0.5, H * 0.1);
      draw(ctx, W, H, t * lane.speed * 0.9 + k * 1.7);
      ctx.restore();
    }
  }
}

function drawSplats(ms) {
  for (let i = splats.length - 1; i >= 0; i--) {
    const s = splats[i];
    const a = (ms - s.t0) / s.life;
    if (a >= 1) { splats.splice(i, 1); continue; }
    ctx.save();
    ctx.globalAlpha = 1 - a;
    ctx.fillStyle = s.col;
    if (!s.petal) ell(ctx, s.x, s.y, S * (0.2 + 0.2 * Math.min(1, a * 3)), S * (0.14 + 0.14 * Math.min(1, a * 3)), 0.4);
    for (const p of s.parts) {
      const d = p.d * S * (s.petal ? a : Math.min(1, a * 2.2));
      const py = s.y + Math.sin(p.a) * d + (s.petal ? a * a * S * 1.2 : 0);
      ell(ctx, s.x + Math.cos(p.a) * d, py, S * p.s, S * p.s * (s.petal ? 0.6 : 1), p.a);
    }
    ctx.restore();
  }
}

function drawName(name, x, y, col) {
  ctx.save();
  ctx.font = "700 " + Math.round(S * 0.28) + "px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,.85)";
  ctx.strokeText(name, x, y);
  ctx.fillStyle = col;
  ctx.fillText(name, x, y);
  ctx.restore();
}

function drawProgress() {
  if (G.mode !== "online" || (G.phase !== "race" && G.phase !== "countdown")) return;
  const W = COLS * S;
  const top = S * 0.6;
  const bot = S * ROWS - S * 0.6;
  const x = W - S * 0.14;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.45)";
  ctx.fillRect(x - 3, top - 6, 6, bot - top + 12);
  for (const p of net.players.values()) {
    const meP = p.id === net.id;
    const py = meP ? L.y : p.y;
    const st = meP ? L.status : p.status;
    if (st === "idle") continue;
    const yy = top + (py / (ROWS - 1)) * (bot - top);
    ctx.fillStyle = PLAYER_COLORS[p.color % 8];
    ctx.globalAlpha = st === "out" ? 0.35 : 1;
    ell(ctx, x, yy, meP ? 5.5 : 4, meP ? 5.5 : 4);
    if (meP) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  ctx.restore();
}

/* ---------- main loop ---------- */

let lastFrame = performance.now();

function frame(ts) {
  requestAnimationFrame(frame);
  const ms = performance.now();
  const dt = Math.min(0.05, (ms - lastFrame) / 1000);
  lastFrame = ms;

  // time source for traffic
  let t;
  if (G.phase === "demo") {
    const li = Math.floor(Date.now() / 14000) % LOCS.length;
    if (G.demoLoc !== li) {
      G.demoLoc = li;
      G.loc = li;
      setTraffic(li, 4242, 1 + (li % 3));
    }
    t = Date.now() / 1000;
  } else {
    t = (now() - G.startAt) / 1000;
  }

  if (G.phase === "countdown" && now() >= G.startAt) G.phase = "race";
  // respawn
  if (L.dead && ms >= L.respawn && L.status === "racing") {
    L.dead = false;
    L.x = 4; L.y = 9; L.fx = 4; L.fy = 9; L.t0 = -1000; L.ang = 0;
    L.invuln = ms + 1300;
    sendPos(false);
  }
  // collisions
  if (G.phase === "race" && L.status === "racing" && !L.dead && ms > L.invuln && now() >= G.startAt) {
    const v = vis();
    const lane = G.laneByRow[Math.round(v.y)];
    if (lane && laneHit(lane, v.x + 0.5, t)) die();
  }
  // ghosts glide toward their reported cell
  for (const p of net.players.values()) {
    if (p.id === net.id) continue;
    const k = Math.min(1, dt * 16);
    p.gx += (p.x - p.gx) * k;
    p.gy += (p.y - p.gy) * k;
  }

  // draw
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, COLS * S, ROWS * S);
  ctx.drawImage(bg(G.loc), 0, 0, COLS * S, ROWS * S);
  drawTraffic(t);

  // rivals
  for (const p of net.players.values()) {
    if (p.id === net.id) continue;
    if (p.status === "out" || p.status === "idle") continue;
    if (p.flash && ms < p.flash) continue;
    const px = p.gx * S + S / 2;
    const py = p.gy * S + S / 2;
    const moving = Math.abs(p.x - p.gx) + Math.abs(p.y - p.gy) > 0.15;
    drawHopper(ctx, px, py, S, 0, PLAYER_COLORS[p.color % 8], moving ? 1.05 : 0.95, 0.72, moving ? 1 : 0);
    drawName(p.name, px, py - S * 0.5, PLAYER_COLORS[p.color % 8]);
  }

  // me
  if (L.status === "racing" || L.status === "finished") {
    if (!L.dead) {
      const v = vis();
      const blink = ms < L.invuln && Math.floor(ms / 90) % 2 === 0;
      const arc = 1 + 0.28 * Math.sin(Math.PI * v.u);
      drawHopper(ctx, v.x * S + S / 2, v.y * S + S / 2, S, L.ang, PLAYER_COLORS[profile.color % 8], arc, blink ? 0.45 : 1, Math.sin(Math.PI * v.u));
      if (G.mode === "online") drawName("YOU", v.x * S + S / 2, v.y * S + S / 2 - S * 0.52, "#ffffff");
    }
  }
  drawSplats(ms);
  drawProgress();

  updateHud(t);
}

/* ---------- input ---------- */

const KEYS = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
  W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
};
window.addEventListener("keydown", (e) => {
  if (e.target && e.target.tagName === "INPUT") return;
  const k = KEYS[e.key];
  if (!k) return;
  e.preventDefault();
  ac();
  hop(k[0], k[1]);
});

for (const b of document.querySelectorAll(".dp")) {
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    ac();
    hop(+b.dataset.dx, +b.dataset.dy);
  });
}

let sw = null;
cv.addEventListener("pointerdown", (e) => {
  ac();
  sw = { x: e.clientX, y: e.clientY };
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
});
cv.addEventListener("pointerup", (e) => {
  if (!sw) return;
  const dx = e.clientX - sw.x;
  const dy = e.clientY - sw.y;
  sw = null;
  if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return hop(0, -1);
  if (Math.abs(dx) > Math.abs(dy)) hop(dx > 0 ? 1 : -1, 0);
  else hop(0, dy > 0 ? 1 : -1);
});
cv.addEventListener("pointercancel", () => { sw = null; });

$("#mute").addEventListener("click", () => {
  soundOn = !soundOn;
  $("#mute").classList.toggle("off", !soundOn);
  ac();
});

/* ---------- menu wiring ---------- */

function readName() {
  const n = $("#callsign").value.replace(/[^\w \-.!]/g, "").trim().slice(0, 14).toUpperCase();
  profile.name = n || "HOPPER";
  try {
    localStorage.setItem("hopper.name", profile.name);
    localStorage.setItem("hopper.color", String(profile.color));
  } catch (e) {}
}

function buildSwatches() {
  const box = $("#swatches");
  box.innerHTML = "";
  PLAYER_COLORS.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sw";
    b.style.background = c;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", "Bandana " + (i + 1));
    b.setAttribute("aria-checked", String(i === profile.color));
    b.addEventListener("click", () => {
      profile.color = i;
      for (const s of box.children) s.setAttribute("aria-checked", "false");
      b.setAttribute("aria-checked", "true");
    });
    box.appendChild(b);
  });
}

function randomCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

function explain(err, code) {
  if (err === "offline") return "Open the Cloudflare link to race online";
  if (err === "full") return "ROOM " + code + " IS FULL";
  return "CAN'T REACH THE RACE SERVER";
}

async function tryJoin(code) {
  readName();
  ac();
  const r = await joinRoom(code);
  if (r !== true) { toast(explain(r, code)); return false; }
  return true;
}

$("#btnQuick").addEventListener("click", async () => {
  readName();
  ac();
  for (let i = 1; i <= 6; i++) {
    const r = await joinRoom("OPEN" + i);
    if (r === true) return;
    if (r !== "full") { toast(explain(r, "")); return; }
  }
  toast("ALL OPEN ROOMS ARE FULL. MAKE A NEW ROOM");
});
$("#btnNew").addEventListener("click", () => tryJoin(randomCode()));
$("#btnJoin").addEventListener("click", () => {
  const code = $("#joinCode").value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (code.length < 3) return toast("ENTER A ROOM CODE");
  tryJoin(code);
});
$("#joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btnJoin").click(); });
$("#btnSolo").addEventListener("click", () => { readName(); ac(); startSolo(0, 1); });

$("#btnReady").addEventListener("click", () => {
  const me = net.players.get(net.id);
  if (!me) return;
  me.ready = !me.ready;
  netSend({ t: "ready", v: me.ready });
  renderRoster();
});
$("#btnNext").addEventListener("click", () => {
  if (G.mode === "solo") {
    const won = L.status === "finished";
    if (won) solo.round += 1;
    startSolo((solo.round - 1) % LOCS.length, solo.round);
    return;
  }
  const me = net.players.get(net.id);
  if (!me) return;
  me.ready = !me.ready;
  netSend({ t: "ready", v: me.ready });
  updateReadyButtons();
});
$("#btnLeave").addEventListener("click", () => closeNet(false));
$("#btnResLeave").addEventListener("click", () => closeNet(false));

$("#btnShare").addEventListener("click", async () => {
  const url = location.origin + "/?room=" + net.room;
  const text = "Race me in Hopper. Room " + net.room;
  try {
    if (navigator.share) { await navigator.share({ title: "Hopper", text, url }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  try {
    await navigator.clipboard.writeText(url);
    toast("INVITE LINK COPIED");
  } catch (e) {
    toast("ROOM CODE: " + net.room);
  }
});

/* ---------- boot ---------- */

function boot() {
  $("#callsign").value = profile.name;
  buildSwatches();
  resize();
  setTraffic(0, 4242, 1);
  goMenu();
  requestAnimationFrame(frame);
  const q = new URLSearchParams(location.search).get("room");
  if (q) {
    const code = q.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    $("#joinCode").value = code;
    if (profile.name) tryJoin(code);
    else toast("PICK A CALLSIGN, THEN TAP JOIN");
  }
}
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { for (const k in bgCache) delete bgCache[k]; });
boot();
