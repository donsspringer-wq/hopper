// Runs the Room Durable Object logic with fake WebSockets, and checks that traffic is always passable.
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);

// ---- fake WebSocketPair / Response so the Room can run under plain node ----
class FakeSocket {
  constructor() { this.sent = []; this.l = {}; this.peer = null; }
  accept() {}
  addEventListener(ev, fn) { (this.l[ev] ||= []).push(fn); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { (this.l.close || []).forEach((f) => f()); }
  fromClient(obj) { (this.l.message || []).forEach((f) => f({ data: JSON.stringify(obj) })); }
  last(t) { return [...this.sent].reverse().find((m) => m.t === t); }
}
globalThis.WebSocketPair = function () { return [new FakeSocket(), new FakeSocket()]; };
globalThis.Response = class { constructor(b, o) { this.status = o && o.status; this.webSocket = o && o.webSocket; } };

const { Room } = await import("../src/worker.js");

function connect(room, name) {
  const s = new FakeSocket();
  room.attach(s);
  s.fromClient({ t: "join", name, color: 0 });
  return s;
}

// ---- lobby, ready, countdown ----
{
  const room = new Room({});
  const a = connect(room, "alpha");
  const b = connect(room, "bravo");
  assert.equal(a.last("welcome").id, 1);
  assert.equal(b.last("welcome").room.players.length, 2);
  assert.notEqual(a.last("joined").p.color, undefined);

  a.fromClient({ t: "ready", v: true });
  assert.equal(room.phase, "lobby", "waits for everyone");
  b.fromClient({ t: "ready", v: true });
  assert.equal(room.phase, "countdown");
  const st = a.last("start");
  assert.equal(st.round, 1);
  assert.equal(st.loc, 0);
  assert.ok(st.startAt > Date.now());

  // finishing before the race clock is rejected
  a.fromClient({ t: "finish" });
  assert.equal(room.players.get(1).status, "racing");

  // jump the clock: race is live
  room.phase = "race";
  room.startAt = Date.now() - 5000;
  a.fromClient({ t: "pos", x: 3, y: 4, l: 3, d: 0 });
  assert.equal(b.last("pos").y, 4, "positions relay to rivals");

  a.fromClient({ t: "finish" });
  const fin = b.last("fin");
  assert.ok(fin && fin.time >= 900, "finish recorded");
  assert.equal(room.phase, "race", "race continues for the pack");

  b.fromClient({ t: "out" });
  assert.equal(room.phase, "results", "ends when everyone is finished or out");
  const res = a.last("results");
  assert.equal(res.results[0].name, "alpha");
  assert.equal(res.results[0].place, 1);
  assert.ok(res.results[0].points >= 1000);
  assert.equal(res.results[1].status, "out");

  // next round rotates the location
  a.fromClient({ t: "ready", v: true });
  b.fromClient({ t: "ready", v: true });
  assert.equal(room.phase, "countdown");
  assert.equal(a.last("start").loc, 1);
  clearTimeout(room.timer);
}

// ---- full room and leaving ----
{
  const room = new Room({});
  const socks = [];
  for (let i = 0; i < 8; i++) socks.push(connect(room, "p" + i));
  const ninth = connect(room, "late");
  assert.ok(ninth.last("full"), "ninth hopper is turned away");
  const colors = new Set([...room.players.values()].map((p) => p.color));
  assert.equal(colors.size, 8, "every hopper gets its own bandana colour");
  socks[0].close();
  assert.equal(room.players.size, 7);
}

// ---- solo race ends when the only hopper finishes ----
{
  const room = new Room({});
  const a = connect(room, "solo");
  a.fromClient({ t: "ready", v: true });
  assert.equal(room.phase, "countdown");
  room.phase = "race";
  room.startAt = Date.now() - 3000;
  a.fromClient({ t: "finish" });
  assert.equal(room.phase, "results");
}

// ---- traffic is deterministic and always passable ----
import fs from "node:fs";
import vm from "node:vm";
const spriteSrc = fs.readFileSync(new URL("../public/sprites.js", import.meta.url), "utf8");
const sp = vm.runInNewContext(spriteSrc + "\n;({ COLS, buildTraffic, laneHit })", {});
for (let loc = 0; loc < 4; loc++) {
  for (let round = 1; round <= 8; round++) {
    const seed = 1000 + loc * 31 + round;
    const a = sp.buildTraffic(loc, seed, round);
    const b = sp.buildTraffic(loc, seed, round);
    assert.deepEqual(a, b, "same seed gives the same traffic");
    assert.equal(a.length, 5);
    for (const lane of a) {
      // sample the lane over time: there must always be a hopper-wide hole
      for (let t = 0; t < 40; t += 0.05) {
        let holes = 0;
        for (let col = 0; col < sp.COLS; col++) if (!sp.laneHit(lane, col + 0.5, t)) holes++;
        assert.ok(holes >= 2, `loc ${loc} round ${round} lane ${lane.type} t=${t.toFixed(2)} has ${holes} open cells`);
      }
    }
  }
}

console.log("all tests passed");
