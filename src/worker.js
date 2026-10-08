// Hopper: Garden Crossing - race server for Cloudflare Workers.
// One Durable Object per room. Clients connect over WebSocket at /ws?room=CODE.
// Static game files are served from ./public by the assets binding.

const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 4000;
const WRAP_UP_MS = 25000; // time left for the others after the first finisher
const RACE_CAP_MS = 120000; // hard stop for any race
const MIN_CROSS_MS = 900; // nine hops at the fastest hop rate, rejects forged finishes
const PLACE_POINTS = [1000, 700, 500, 350, 250, 180, 120, 80];
const LOCATIONS = 4;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const code = cleanCode(url.searchParams.get("room"));
      if (!code) return new Response("Bad room code", { status: 400 });
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      return stub.fetch(request);
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("Not found", { status: 404 });
  },
};

function cleanCode(s) {
  const c = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return c.length >= 3 ? c : "";
}

function cleanName(s) {
  const n = String(s || "")
    .replace(/[^\w \-.!]/g, "")
    .trim()
    .slice(0, 14);
  return n || "HOPPER";
}

export class Room {
  constructor(state) {
    this.state = state;
    this.players = new Map(); // id -> player
    this.nextId = 1;
    this.phase = "lobby"; // lobby | countdown | race | results
    this.round = 0;
    this.loc = 0;
    this.seed = 0;
    this.startAt = 0;
    this.firstFinishAt = 0;
    this.timer = null;
    this.results = [];
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  attach(ws) {
    let me = null;
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!m || typeof m.t !== "string") return;
      if (m.t === "ping") {
        this.send(ws, { t: "pong", c: m.c, s: Date.now() });
        return;
      }
      if (m.t === "join") {
        if (me) return;
        if (this.players.size >= MAX_PLAYERS) {
          this.send(ws, { t: "full" });
          try { ws.close(1000, "full"); } catch {}
          return;
        }
        me = this.addPlayer(ws, m);
        return;
      }
      if (!me) return;
      this.onMessage(me, m);
    });
    const drop = () => {
      if (me) this.removePlayer(me);
      me = null;
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  broadcast(obj, exceptId) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.id === exceptId) continue;
      try {
        p.ws.send(s);
      } catch {}
    }
  }

  addPlayer(ws, m) {
    const used = new Set([...this.players.values()].map((p) => p.color));
    let color = Number.isInteger(m.color) ? m.color : 0;
    color = ((color % 8) + 8) % 8;
    if (used.has(color)) {
      for (let i = 0; i < 8; i++) if (!used.has(i)) { color = i; break; }
    }
    const p = {
      id: this.nextId++,
      ws,
      name: cleanName(m.name),
      color,
      ready: false,
      x: 4,
      y: 9,
      lives: 3,
      status: "idle", // idle | racing | finished | out
      time: 0,
      place: 0,
      points: 0,
      total: 0,
      lastPos: 0,
    };
    this.players.set(p.id, p);
    this.send(ws, { t: "welcome", id: p.id, now: Date.now(), room: this.snapshot() });
    this.broadcast({ t: "joined", p: this.pub(p) }, p.id);
    return p;
  }

  removePlayer(p) {
    if (!this.players.delete(p.id)) return;
    this.broadcast({ t: "left", id: p.id });
    if (this.players.size === 0) {
      clearTimeout(this.timer);
      this.timer = null;
      this.phase = "lobby";
      this.round = 0;
      return;
    }
    if (this.phase === "race") this.checkRaceEnd();
    else this.maybeStart();
  }

  pub(p) {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      ready: p.ready,
      x: p.x,
      y: p.y,
      lives: p.lives,
      status: p.status,
      time: p.time,
      place: p.place,
      points: p.points,
      total: p.total,
    };
  }

  snapshot() {
    return {
      phase: this.phase,
      round: this.round,
      loc: this.loc,
      seed: this.seed,
      startAt: this.startAt,
      players: [...this.players.values()].map((p) => this.pub(p)),
    };
  }

  onMessage(p, m) {
    switch (m.t) {
      case "ready": {
        if (this.phase !== "lobby" && this.phase !== "results") return;
        p.ready = !!m.v;
        this.broadcast({ t: "ready", id: p.id, v: p.ready });
        this.maybeStart();
        break;
      }
      case "pos": {
        if (this.phase !== "race" && this.phase !== "countdown") return;
        const now = Date.now();
        if (now - p.lastPos < 40) return;
        p.lastPos = now;
        const x = clampInt(m.x, 0, 8);
        const y = clampInt(m.y, 0, 9);
        if (x === null || y === null) return;
        p.x = x;
        p.y = y;
        p.lives = clampInt(m.l, 0, 3) ?? p.lives;
        this.broadcast({ t: "pos", id: p.id, x, y, l: p.lives, d: m.d ? 1 : 0 }, p.id);
        break;
      }
      case "finish": {
        if (this.phase !== "race" || p.status !== "racing") return;
        const t = Date.now() - this.startAt;
        if (t < MIN_CROSS_MS) return;
        p.status = "finished";
        p.time = t;
        p.y = 0;
        if (!this.firstFinishAt) {
          this.firstFinishAt = Date.now();
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.endRace(), WRAP_UP_MS);
        }
        this.broadcast({ t: "fin", id: p.id, time: t });
        this.checkRaceEnd();
        break;
      }
      case "out": {
        if (this.phase !== "race" || p.status !== "racing") return;
        p.status = "out";
        p.lives = 0;
        this.broadcast({ t: "out", id: p.id });
        this.checkRaceEnd();
        break;
      }
    }
  }

  maybeStart() {
    if (this.phase !== "lobby" && this.phase !== "results") return;
    if (this.players.size === 0) return;
    for (const p of this.players.values()) if (!p.ready) return;
    this.round += 1;
    this.loc = (this.round - 1) % LOCATIONS;
    this.seed = (Math.random() * 2 ** 31) | 0;
    this.startAt = Date.now() + COUNTDOWN_MS;
    this.firstFinishAt = 0;
    this.phase = "countdown";
    for (const p of this.players.values()) {
      p.status = "racing";
      p.x = 4;
      p.y = 9;
      p.lives = 3;
      p.time = 0;
      p.place = 0;
      p.points = 0;
    }
    this.broadcast({
      t: "start",
      round: this.round,
      loc: this.loc,
      seed: this.seed,
      startAt: this.startAt,
      now: Date.now(),
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.phase !== "countdown") return;
      this.phase = "race";
      this.timer = setTimeout(() => this.endRace(), RACE_CAP_MS);
    }, COUNTDOWN_MS);
  }

  checkRaceEnd() {
    if (this.phase !== "race") return;
    for (const p of this.players.values()) if (p.status === "racing") return;
    this.endRace();
  }

  endRace() {
    if (this.phase !== "race" && this.phase !== "countdown") return;
    clearTimeout(this.timer);
    this.timer = null;
    this.phase = "results";
    // Players who joined mid-race (status idle) watch; they are not ranked.
    for (const p of this.players.values()) p.ready = false;
    const all = [...this.players.values()].filter((p) => p.status !== "idle");
    const finished = all.filter((p) => p.status === "finished").sort((a, b) => a.time - b.time);
    finished.forEach((p, i) => {
      p.place = i + 1;
      p.points = (PLACE_POINTS[i] ?? 60) + p.lives * 50;
    });
    const rest = all.filter((p) => p.status !== "finished");
    // Did-not-finish: more progress (smaller y) ranks higher.
    rest.sort((a, b) => a.y - b.y);
    rest.forEach((p, i) => {
      p.place = finished.length + i + 1;
      p.points = Math.max(0, (9 - p.y) * 8);
      p.status = p.status === "out" ? "out" : "dnf";
    });
    for (const p of all) p.total += p.points;
    this.results = [...finished, ...rest].map((p) => this.pub(p));
    this.broadcast({ t: "results", round: this.round, results: this.results });
  }
}

function clampInt(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
