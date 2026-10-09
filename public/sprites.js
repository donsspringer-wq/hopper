/* Hopper: Garden Crossing - field layout, traffic and drawing code. */
"use strict";

const COLS = 9;
const ROWS = 10;
// Row 0 is the finish (flowers), row 9 is the start. Five traffic lanes.
const ROWTYPE = ["goal", "lane", "lane", "safe", "lane", "safe", "lane", "lane", "safe", "start"];
const LANEROWS = [1, 2, 4, 6, 7];
const MARGIN = 3.4;
const PERIOD = COLS + 2 * MARGIN;

const PLAYER_COLORS = ["#ff6a1a", "#2ec4ff", "#d7ff3a", "#ff3b4e", "#ffd23a", "#f2efe4", "#b65cff", "#8fa3a8"];

// w = width in cells, speed = cells per second, n = vehicles per lane
const SP_DEF = {
  rabbit: { w: 1.1, speed: 2.7, n: 2 },
  mower: { w: 2.0, speed: 1.7, n: 2 },
  snail: { w: 0.9, speed: 0.6, n: 3 },
  barrow: { w: 1.9, speed: 1.35, n: 2 },
  squirrel: { w: 1.1, speed: 2.3, n: 3 },
  goose: { w: 1.0, speed: 1.9, n: 3 },
  tractor: { w: 3.0, speed: 1.05, n: 2 },
  chicken: { w: 0.8, speed: 2.0, n: 3 },
  hay: { w: 3.0, speed: 1.6, n: 2 },
  pickup: { w: 2.2, speed: 2.5, n: 2 },
  moto: { w: 1.3, speed: 3.6, n: 2 },
  sedan: { w: 2.0, speed: 2.6, n: 2 },
  atv: { w: 1.5, speed: 3.0, n: 2 },
  mail: { w: 3.0, speed: 1.9, n: 2 },
  roomba: { w: 1.0, speed: 1.3, n: 3 },
  cat: { w: 1.4, speed: 3.1, n: 2 },
  slipper: { w: 1.1, speed: 1.9, n: 3 },
  toytruck: { w: 1.5, speed: 2.3, n: 2 },
  bucket: { w: 1.1, speed: 1.6, n: 3 },
};

const LOCS = [
  {
    name: "GARDEN CROSSING",
    short: "THE GARDEN",
    lanes: ["rabbit", "mower", "snail", "barrow", "squirrel"],
    laneCol: "#3a281a",
    laneSpeck: ["#2b1c11", "#523725", "#6a4a33"],
    safeCol: "#2b561e",
    blade: ["#3f7a2a", "#224716", "#5a9a38"],
    goalCol: "#1d3a14",
  },
  {
    name: "BARNYARD RUN",
    short: "THE BARNYARD",
    lanes: ["goose", "tractor", "chicken", "hay", "pickup"],
    laneCol: "#5a4530",
    laneSpeck: ["#46341f", "#6e553a", "#c9a64a"],
    safeCol: "#3a5c25",
    blade: ["#4b7a2c", "#2e4c1a", "#6a9a3a"],
    goalCol: "#6b2418",
  },
  {
    name: "DRIVEWAY DASH",
    short: "THE DRIVEWAY",
    lanes: ["moto", "sedan", "atv", "mail", "pickup"],
    laneCol: "#2a2c2f",
    laneSpeck: ["#1d1f21", "#3a3d41", "#4a4e53"],
    safeCol: "#62666a",
    blade: ["#555a5e", "#70757a", "#4a4e52"],
    goalCol: "#4a2f1e",
  },
  {
    name: "KITCHEN FLOOR",
    short: "THE KITCHEN",
    lanes: ["roomba", "cat", "slipper", "toytruck", "bucket"],
    laneCol: "#b9b19a",
    laneSpeck: ["#a39c87", "#c9c2ad", "#8f8872"],
    safeCol: "#7a4e2a",
    blade: ["#6a4224", "#8a5a32", "#5a371c"],
    goalCol: "#3d4b52",
  },
];

/* ---------- deterministic random + traffic ---------- */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mod(a, n) {
  return ((a % n) + n) % n;
}

// Every player builds the same traffic from (location, seed, round) and the shared race clock.
function buildTraffic(li, seed, round) {
  const loc = LOCS[li % LOCS.length];
  const r = mulberry32((seed ^ (li * 7919) ^ (round * 104729)) | 0);
  const diff = Math.min(1.75, 1 + 0.07 * (round - 1));
  const flip = r() < 0.5 ? 1 : -1;
  return loc.lanes.map((type, i) => {
    const d = SP_DEF[type];
    const spacing = PERIOD / d.n;
    const base = [];
    for (let k = 0; k < d.n; k++) base.push(k * spacing + (r() - 0.5) * spacing * 0.22);
    return {
      row: LANEROWS[i],
      type,
      w: d.w,
      dir: (i % 2 === 0 ? 1 : -1) * flip,
      speed: d.speed * (0.92 + r() * 0.16) * diff,
      base,
    };
  });
}

function itemX(lane, k, t) {
  return mod(lane.base[k] + lane.dir * lane.speed * t, PERIOD) - MARGIN;
}

// true when a hopper centred at hx (cells) is hit by anything in the lane at time t
function laneHit(lane, hx, t) {
  for (let k = 0; k < lane.base.length; k++) {
    const x = itemX(lane, k, t);
    if (hx + 0.26 > x + 0.14 && hx - 0.26 < x + lane.w - 0.14) return true;
  }
  return false;
}

/* ---------- small drawing helpers ---------- */

function ell(c, x, y, rx, ry, rot) {
  c.beginPath();
  c.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot || 0, 0, Math.PI * 2);
  c.fill();
}
function rrect(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) c.roundRect(x, y, w, h, r);
  else c.rect(x, y, w, h);
  c.fill();
}
function wheel(c, x, y, r, ph) {
  c.fillStyle = "#101010";
  ell(c, x, y, r, r);
  c.fillStyle = "#6a6a62";
  ell(c, x, y, r * 0.5, r * 0.5);
  c.strokeStyle = "#101010";
  c.lineWidth = Math.max(1, r * 0.18);
  c.beginPath();
  c.moveTo(x + Math.cos(ph) * r * 0.5, y + Math.sin(ph) * r * 0.5);
  c.lineTo(x - Math.cos(ph) * r * 0.5, y - Math.sin(ph) * r * 0.5);
  c.stroke();
}

/* ---------- obstacle sprites: drawn facing right in a W x H box ---------- */

const SP = {
  rabbit(c, W, H, t) {
    const hop = Math.abs(Math.sin(t * 9)) * H * 0.16;
    c.translate(0, -hop);
    c.fillStyle = "#fff";
    ell(c, W * 0.1, H * 0.62, W * 0.09, W * 0.09);
    c.fillStyle = "#8a6a48";
    ell(c, W * 0.46, H * 0.62, W * 0.36, H * 0.27);
    c.fillStyle = "#9c7b55";
    ell(c, W * 0.82, H * 0.44, W * 0.17, H * 0.2);
    c.fillStyle = "#7a5a3a";
    ell(c, W * 0.76, H * 0.1, W * 0.045, H * 0.22, -0.25);
    ell(c, W * 0.86, H * 0.1, W * 0.045, H * 0.22, 0.15);
    c.fillStyle = "#111";
    ell(c, W * 0.88, H * 0.4, W * 0.025, W * 0.025);
    c.fillStyle = "#e9a1a1";
    ell(c, W * 0.98, H * 0.48, W * 0.025, W * 0.02);
  },
  mower(c, W, H, t) {
    c.strokeStyle = "#222";
    c.lineWidth = Math.max(2, H * 0.07);
    c.beginPath();
    c.moveTo(0, H * 0.1);
    c.lineTo(W * 0.3, H * 0.45);
    c.stroke();
    c.fillStyle = "#c92a1c";
    rrect(c, W * 0.28, H * 0.16, W * 0.7, H * 0.68, H * 0.12);
    c.fillStyle = "#8d1a10";
    rrect(c, W * 0.28, H * 0.66, W * 0.7, H * 0.18, H * 0.08);
    c.fillStyle = "#1c1c1c";
    rrect(c, W * 0.4, H * 0.26, W * 0.26, H * 0.34, H * 0.06);
    c.fillStyle = "#bdbdbd";
    ell(c, W * 0.78, H * 0.42, H * 0.14, H * 0.14);
    wheel(c, W * 0.36, H * 0.86, H * 0.13, t * 6);
    wheel(c, W * 0.88, H * 0.86, H * 0.13, t * 6);
    c.fillStyle = "#4f8a2a";
    for (let i = 0; i < 3; i++) ell(c, W * (0.98 + i * 0.01), H * (0.3 + i * 0.12) + Math.sin(t * 20 + i) * 2, 2.5, 1.5);
  },
  snail(c, W, H, t) {
    c.fillStyle = "rgba(200,220,230,.35)";
    rrect(c, -W * 0.5, H * 0.74, W * 0.9, H * 0.07, 3);
    c.fillStyle = "#d8c7a0";
    ell(c, W * 0.5, H * 0.74, W * 0.5, H * 0.14);
    c.fillStyle = "#c9b68c";
    ell(c, W * 0.92, H * 0.6, W * 0.1, H * 0.15);
    c.strokeStyle = "#b9a679";
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(W * 0.95, H * 0.5);
    c.lineTo(W * 1.02, H * 0.3 + Math.sin(t * 3) * 2);
    c.moveTo(W * 0.9, H * 0.5);
    c.lineTo(W * 0.92, H * 0.28);
    c.stroke();
    c.fillStyle = "#a8652f";
    ell(c, W * 0.42, H * 0.46, H * 0.3, H * 0.3);
    c.strokeStyle = "#6a3d19";
    c.lineWidth = 2;
    c.beginPath();
    c.arc(W * 0.42, H * 0.46, H * 0.19, 0, Math.PI * 1.6);
    c.arc(W * 0.42, H * 0.46, H * 0.09, 0, Math.PI * 1.5);
    c.stroke();
  },
  barrow(c, W, H, t) {
    c.strokeStyle = "#6b4a2a";
    c.lineWidth = Math.max(2, H * 0.07);
    c.beginPath();
    c.moveTo(0, H * 0.3);
    c.lineTo(W * 0.38, H * 0.5);
    c.stroke();
    c.fillStyle = "#2c7a3a";
    c.beginPath();
    c.moveTo(W * 0.3, H * 0.22);
    c.lineTo(W * 0.96, H * 0.18);
    c.lineTo(W * 0.84, H * 0.66);
    c.lineTo(W * 0.4, H * 0.66);
    c.closePath();
    c.fill();
    c.fillStyle = "#4b3322";
    ell(c, W * 0.64, H * 0.2, W * 0.28, H * 0.1);
    wheel(c, W * 0.9, H * 0.76, H * 0.16, t * 5);
    c.fillStyle = "#222";
    rrect(c, W * 0.3, H * 0.66, W * 0.1, H * 0.2, 2);
  },
  squirrel(c, W, H, t) {
    const bob = Math.sin(t * 14) * H * 0.04;
    c.translate(0, bob);
    c.fillStyle = "#8b8f94";
    ell(c, W * 0.2, H * 0.4, W * 0.22, H * 0.34, -0.5);
    c.fillStyle = "#7a7e84";
    ell(c, W * 0.5, H * 0.62, W * 0.28, H * 0.2);
    c.fillStyle = "#969a9f";
    ell(c, W * 0.82, H * 0.5, W * 0.15, H * 0.17);
    c.fillStyle = "#6c7076";
    ell(c, W * 0.78, H * 0.3, W * 0.05, H * 0.1);
    c.fillStyle = "#111";
    ell(c, W * 0.88, H * 0.47, W * 0.025, W * 0.025);
  },
  goose(c, W, H, t) {
    const bob = Math.sin(t * 10) * H * 0.03;
    c.translate(0, bob);
    c.fillStyle = "#f2f0e6";
    ell(c, W * 0.4, H * 0.62, W * 0.4, H * 0.27);
    c.strokeStyle = "#f2f0e6";
    c.lineWidth = Math.max(3, H * 0.12);
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(W * 0.66, H * 0.55);
    c.quadraticCurveTo(W * 0.9, H * 0.4, W * 0.84, H * 0.16);
    c.stroke();
    c.fillStyle = "#f2f0e6";
    ell(c, W * 0.84, H * 0.14, W * 0.1, H * 0.1);
    c.fillStyle = "#ff9a1a";
    c.beginPath();
    c.moveTo(W * 0.92, H * 0.1);
    c.lineTo(W * 1.08, H * 0.16);
    c.lineTo(W * 0.92, H * 0.2);
    c.fill();
    c.fillStyle = "#111";
    ell(c, W * 0.86, H * 0.11, 1.8, 1.8);
  },
  tractor(c, W, H, t) {
    c.fillStyle = "#2f8a34";
    rrect(c, W * 0.3, H * 0.34, W * 0.66, H * 0.3, H * 0.06);
    c.fillStyle = "#ffc21a";
    rrect(c, W * 0.3, H * 0.52, W * 0.66, H * 0.06, 1);
    c.fillStyle = "#256f2b";
    rrect(c, W * 0.32, H * 0.06, W * 0.3, H * 0.34, H * 0.05);
    c.fillStyle = "#9fd6e4";
    rrect(c, W * 0.35, H * 0.1, W * 0.24, H * 0.2, H * 0.03);
    c.fillStyle = "#555";
    rrect(c, W * 0.8, H * 0.14, W * 0.04, H * 0.22, 1);
    c.fillStyle = "rgba(60,60,60,.5)";
    ell(c, W * 0.82, H * 0.08 - ((t * 10) % 1) * 3, 4, 3);
    wheel(c, W * 0.3, H * 0.68, H * 0.3, t * 3);
    wheel(c, W * 0.84, H * 0.8, H * 0.17, t * 4);
    c.fillStyle = "#ffe36a";
    ell(c, W * 0.97, H * 0.46, H * 0.05, H * 0.05);
  },
  chicken(c, W, H, t) {
    const bob = Math.abs(Math.sin(t * 12)) * H * 0.08;
    c.translate(0, -bob);
    c.fillStyle = "#f4f1e8";
    ell(c, W * 0.4, H * 0.58, W * 0.34, H * 0.3);
    c.fillStyle = "#e0dccb";
    ell(c, W * 0.26, H * 0.55, W * 0.2, H * 0.17);
    c.fillStyle = "#f4f1e8";
    ell(c, W * 0.78, H * 0.36, W * 0.16, H * 0.18);
    c.fillStyle = "#d62b1f";
    ell(c, W * 0.76, H * 0.16, W * 0.07, H * 0.08);
    c.fillStyle = "#ffb21a";
    c.beginPath();
    c.moveTo(W * 0.92, H * 0.34);
    c.lineTo(W * 1.08, H * 0.4);
    c.lineTo(W * 0.92, H * 0.45);
    c.fill();
    c.fillStyle = "#111";
    ell(c, W * 0.82, H * 0.32, 1.6, 1.6);
  },
  hay(c, W, H, t) {
    c.strokeStyle = "#4a3320";
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(0, H * 0.5);
    c.lineTo(W * 0.14, H * 0.5);
    c.stroke();
    c.fillStyle = "#7a5230";
    rrect(c, W * 0.12, H * 0.2, W * 0.86, H * 0.56, 4);
    c.fillStyle = "#d9b44a";
    rrect(c, W * 0.15, H * 0.08, W * 0.8, H * 0.5, H * 0.1);
    c.strokeStyle = "#a9842a";
    c.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      c.moveTo(W * (0.2 + i * 0.12), H * 0.12);
      c.lineTo(W * (0.24 + i * 0.12), H * 0.54);
      c.stroke();
    }
    wheel(c, W * 0.3, H * 0.82, H * 0.14, t * 4);
    wheel(c, W * 0.82, H * 0.82, H * 0.14, t * 4);
  },
  pickup(c, W, H, t) {
    c.fillStyle = "#a63a1c";
    rrect(c, W * 0.02, H * 0.22, W * 0.96, H * 0.5, H * 0.1);
    c.fillStyle = "#7d2a12";
    rrect(c, W * 0.06, H * 0.28, W * 0.42, H * 0.36, 3);
    c.fillStyle = "#8f3218";
    rrect(c, W * 0.5, H * 0.14, W * 0.3, H * 0.52, H * 0.08);
    c.fillStyle = "#a8d4e0";
    rrect(c, W * 0.58, H * 0.2, W * 0.18, H * 0.4, 3);
    c.fillStyle = "#ffe36a";
    rrect(c, W * 0.94, H * 0.3, W * 0.05, H * 0.12, 2);
    c.fillStyle = "#d33";
    rrect(c, W * 0.01, H * 0.3, W * 0.03, H * 0.1, 1);
    wheel(c, W * 0.22, H * 0.78, H * 0.18, t * 8);
    wheel(c, W * 0.78, H * 0.78, H * 0.18, t * 8);
  },
  moto(c, W, H, t) {
    wheel(c, W * 0.2, H * 0.72, H * 0.2, t * 10);
    wheel(c, W * 0.82, H * 0.72, H * 0.2, t * 10);
    c.fillStyle = "#1c1c20";
    rrect(c, W * 0.28, H * 0.42, W * 0.46, H * 0.2, 4);
    c.fillStyle = "#c92a1c";
    rrect(c, W * 0.4, H * 0.3, W * 0.28, H * 0.18, 5);
    c.strokeStyle = "#999";
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(W * 0.82, H * 0.72);
    c.lineTo(W * 0.7, H * 0.3);
    c.stroke();
    c.fillStyle = "#2a2e33";
    ell(c, W * 0.5, H * 0.24, W * 0.12, H * 0.16);
    c.fillStyle = "#ff6a1a";
    ell(c, W * 0.58, H * 0.12, W * 0.08, H * 0.1);
    c.fillStyle = "#ffe36a";
    ell(c, W * 0.94, H * 0.46, 3, 3);
  },
  sedan(c, W, H, t) {
    c.fillStyle = "#3a5f7a";
    rrect(c, W * 0.02, H * 0.3, W * 0.96, H * 0.42, H * 0.12);
    c.fillStyle = "#2d4a5f";
    rrect(c, W * 0.24, H * 0.12, W * 0.5, H * 0.34, H * 0.1);
    c.fillStyle = "#b7dce8";
    rrect(c, W * 0.3, H * 0.17, W * 0.14, H * 0.24, 2);
    rrect(c, W * 0.5, H * 0.17, W * 0.2, H * 0.24, 2);
    c.fillStyle = "#ffe36a";
    rrect(c, W * 0.94, H * 0.36, W * 0.05, H * 0.1, 2);
    c.fillStyle = "#d33";
    rrect(c, W * 0.01, H * 0.36, W * 0.04, H * 0.1, 2);
    wheel(c, W * 0.24, H * 0.74, H * 0.17, t * 8);
    wheel(c, W * 0.76, H * 0.74, H * 0.17, t * 8);
  },
  atv(c, W, H, t) {
    wheel(c, W * 0.2, H * 0.76, H * 0.19, t * 9);
    wheel(c, W * 0.8, H * 0.76, H * 0.19, t * 9);
    c.fillStyle = "#3d7a2a";
    rrect(c, W * 0.12, H * 0.42, W * 0.78, H * 0.28, H * 0.1);
    c.fillStyle = "#1c1c1c";
    rrect(c, W * 0.3, H * 0.34, W * 0.32, H * 0.14, 3);
    c.fillStyle = "#ff6a1a";
    ell(c, W * 0.44, H * 0.2, W * 0.1, H * 0.16);
    c.fillStyle = "#222";
    ell(c, W * 0.5, H * 0.06, W * 0.07, H * 0.08);
    c.fillStyle = "#ffe36a";
    ell(c, W * 0.93, H * 0.5, 3, 3);
  },
  mail(c, W, H, t) {
    c.fillStyle = "#e8eaee";
    rrect(c, W * 0.02, H * 0.1, W * 0.7, H * 0.62, 5);
    c.fillStyle = "#2b4fa8";
    rrect(c, W * 0.02, H * 0.42, W * 0.7, H * 0.08, 1);
    c.fillStyle = "#cfd3da";
    rrect(c, W * 0.72, H * 0.24, W * 0.26, H * 0.48, H * 0.1);
    c.fillStyle = "#a8d4e0";
    rrect(c, W * 0.8, H * 0.3, W * 0.14, H * 0.24, 3);
    c.fillStyle = "#c92a1c";
    rrect(c, W * 0.1, H * 0.2, W * 0.14, H * 0.1, 1);
    c.fillStyle = "#ffe36a";
    rrect(c, W * 0.95, H * 0.58, W * 0.04, H * 0.09, 1);
    wheel(c, W * 0.22, H * 0.76, H * 0.17, t * 7);
    wheel(c, W * 0.82, H * 0.76, H * 0.17, t * 7);
  },
  roomba(c, W, H, t) {
    const R = Math.min(W, H) * 0.46;
    c.fillStyle = "#1a1c1e";
    ell(c, W * 0.5, H * 0.5, R, R);
    c.fillStyle = "#2c3034";
    ell(c, W * 0.5, H * 0.5, R * 0.86, R * 0.86);
    c.strokeStyle = "#7fe0ff";
    c.lineWidth = 2;
    c.beginPath();
    c.arc(W * 0.5, H * 0.5, R * 0.9, -0.6, 0.6);
    c.stroke();
    c.fillStyle = "#555b61";
    ell(c, W * 0.5, H * 0.5, R * 0.3, R * 0.3);
    c.fillStyle = "#7fe0ff";
    ell(c, W * 0.5, H * 0.5, R * 0.1, R * 0.1);
    c.strokeStyle = "#cfd3da";
    c.lineWidth = 2;
    const a = t * 12;
    c.beginPath();
    c.moveTo(W * 0.86 + Math.cos(a) * 6, H * 0.5 + Math.sin(a) * 6);
    c.lineTo(W * 0.86 - Math.cos(a) * 6, H * 0.5 - Math.sin(a) * 6);
    c.stroke();
  },
  cat(c, W, H, t) {
    const bob = Math.sin(t * 13) * H * 0.04;
    c.translate(0, bob);
    c.strokeStyle = "#d9822b";
    c.lineWidth = Math.max(3, H * 0.1);
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(W * 0.14, H * 0.5);
    c.quadraticCurveTo(-W * 0.04, H * 0.2, W * 0.06, H * 0.05);
    c.stroke();
    c.fillStyle = "#e8923a";
    ell(c, W * 0.46, H * 0.56, W * 0.34, H * 0.24);
    c.fillStyle = "#b8661c";
    for (let i = 0; i < 4; i++) rrect(c, W * (0.28 + i * 0.1), H * 0.36, W * 0.035, H * 0.2, 1);
    c.fillStyle = "#e8923a";
    ell(c, W * 0.82, H * 0.42, W * 0.15, H * 0.19);
    c.beginPath();
    c.moveTo(W * 0.74, H * 0.28);
    c.lineTo(W * 0.76, H * 0.06);
    c.lineTo(W * 0.84, H * 0.26);
    c.moveTo(W * 0.84, H * 0.26);
    c.lineTo(W * 0.92, H * 0.08);
    c.lineTo(W * 0.94, H * 0.3);
    c.fill();
    c.fillStyle = "#9bff4a";
    ell(c, W * 0.88, H * 0.38, W * 0.03, H * 0.05);
    c.fillStyle = "#111";
    ell(c, W * 0.88, H * 0.38, 1.2, H * 0.04);
  },
  slipper(c, W, H, t) {
    c.fillStyle = "#e58aa6";
    ell(c, W * 0.5, H * 0.55, W * 0.5, H * 0.3);
    c.fillStyle = "#f2a8bf";
    ell(c, W * 0.58, H * 0.5, W * 0.38, H * 0.2);
    c.fillStyle = "#4a2a33";
    ell(c, W * 0.28, H * 0.54, W * 0.18, H * 0.16);
    c.strokeStyle = "rgba(255,255,255,.35)";
    c.lineWidth = 1.5;
    for (let i = 0; i < 5; i++) {
      c.beginPath();
      c.arc(W * (0.5 + i * 0.09), H * 0.42, 3, 0, Math.PI);
      c.stroke();
    }
  },
  toytruck(c, W, H, t) {
    c.fillStyle = "#ffc21a";
    rrect(c, W * 0.5, H * 0.2, W * 0.46, H * 0.5, 4);
    c.fillStyle = "#8fd0ee";
    rrect(c, W * 0.74, H * 0.26, W * 0.18, H * 0.22, 2);
    c.fillStyle = "#d33a2a";
    rrect(c, W * 0.04, H * 0.26, W * 0.44, H * 0.44, 3);
    c.fillStyle = "#a82a1c";
    rrect(c, W * 0.04, H * 0.26, W * 0.44, H * 0.1, 2);
    wheel(c, W * 0.24, H * 0.76, H * 0.19, t * 8);
    wheel(c, W * 0.78, H * 0.76, H * 0.19, t * 8);
  },
  bucket(c, W, H, t) {
    c.strokeStyle = "#8a6a3a";
    c.lineWidth = Math.max(2, H * 0.07);
    c.beginPath();
    c.moveTo(W * 0.1, H * 0.04);
    c.lineTo(W * 0.5, H * 0.46);
    c.stroke();
    c.fillStyle = "#c9c4b4";
    ell(c, W * 0.14, H * 0.1, W * 0.16, H * 0.1);
    c.fillStyle = "#f2c21a";
    c.beginPath();
    c.moveTo(W * 0.3, H * 0.34);
    c.lineTo(W * 0.96, H * 0.34);
    c.lineTo(W * 0.86, H * 0.82);
    c.lineTo(W * 0.4, H * 0.82);
    c.closePath();
    c.fill();
    c.fillStyle = "#5fb8e8";
    ell(c, W * 0.63, H * 0.36 + Math.sin(t * 9) * 1.5, W * 0.3, H * 0.07);
    c.fillStyle = "#222";
    ell(c, W * 0.42, H * 0.88, 3, 3);
    ell(c, W * 0.84, H * 0.88, 3, 3);
  },
};

/* ---------- the hopper ---------- */

// Top-down grasshopper facing up at (x,y). S = cell size in px. leg = 0..1 hop stretch.
function drawHopper(c, x, y, S, ang, band, scale, alpha, leg) {
  c.save();
  c.globalAlpha = alpha;
  c.translate(x, y);
  c.rotate(ang);
  const k = (S / 64) * scale;
  c.scale(k, k);
  c.lineCap = "round";
  c.lineJoin = "round";
  // shadow
  c.fillStyle = "rgba(0,0,0,.28)";
  ell(c, 3, 8, 20, 30);
  const stretch = leg || 0;
  // legs
  c.strokeStyle = "#2b5f1c";
  for (const s of [-1, 1]) {
    c.lineWidth = 4.5;
    c.beginPath();
    c.moveTo(s * 7, 8);
    c.lineTo(s * (22 + stretch * 4), -4 + stretch * 6);
    c.lineTo(s * (24 + stretch * 3), 24 + stretch * 14);
    c.stroke();
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(s * 6, -2);
    c.lineTo(s * 18, -10);
    c.lineTo(s * 21, -2 + stretch * 3);
    c.stroke();
    c.beginPath();
    c.moveTo(s * 5, -10);
    c.lineTo(s * 13, -20);
    c.lineTo(s * 15, -14);
    c.stroke();
  }
  // wings and abdomen
  c.fillStyle = "#4a9a26";
  ell(c, 0, 17, 9, 21);
  c.fillStyle = "#6bc23a";
  ell(c, -4, 18, 4, 17, 0.1);
  ell(c, 4, 18, 4, 17, -0.1);
  c.strokeStyle = "rgba(20,50,10,.45)";
  c.lineWidth = 1.5;
  for (let i = 0; i < 5; i++) {
    c.beginPath();
    c.moveTo(-8, 8 + i * 6);
    c.lineTo(8, 8 + i * 6);
    c.stroke();
  }
  // thorax plate
  c.fillStyle = "#37801f";
  ell(c, 0, -3, 8.5, 10);
  c.fillStyle = "#2a6616";
  ell(c, 0, -3, 5, 6);
  // head
  c.fillStyle = "#4a9a26";
  ell(c, 0, -18, 7.5, 8.5);
  // bandana in the player's colour
  c.fillStyle = band;
  c.fillRect(-8, -21.5, 16, 4);
  c.fillStyle = "#000";
  c.globalAlpha = alpha * 0.35;
  c.fillRect(-8, -17.5, 16, 1);
  c.globalAlpha = alpha;
  // eyes
  c.fillStyle = "#ff8a1a";
  ell(c, -5, -23, 2.6, 3.2);
  ell(c, 5, -23, 2.6, 3.2);
  c.fillStyle = "#1a0a00";
  ell(c, -5, -23.8, 1, 1.4);
  ell(c, 5, -23.8, 1, 1.4);
  // antennae
  c.strokeStyle = "#2b5f1c";
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(-3, -25);
  c.quadraticCurveTo(-8, -34, -14, -36);
  c.moveTo(3, -25);
  c.quadraticCurveTo(8, -34, 14, -36);
  c.stroke();
  c.restore();
}

function drawSunflower(c, x, y, r, rot) {
  c.save();
  c.translate(x, y);
  c.rotate(rot || 0);
  for (let i = 0; i < 14; i++) {
    c.rotate((Math.PI * 2) / 14);
    c.fillStyle = i % 2 ? "#ffc21a" : "#ffb000";
    ell(c, r * 0.95, 0, r * 0.5, r * 0.2);
  }
  c.fillStyle = "#4a2a12";
  ell(c, 0, 0, r * 0.52, r * 0.52);
  c.fillStyle = "#2a1608";
  ell(c, 0, 0, r * 0.34, r * 0.34);
  c.restore();
}

/* ---------- backgrounds ---------- */

function speck(c, r, x, y, w, h, n, cols, sz) {
  for (let i = 0; i < n; i++) {
    c.fillStyle = cols[(r() * cols.length) | 0];
    c.fillRect(x + r() * w, y + r() * h, sz * (0.6 + r()), sz * (0.6 + r()));
  }
}

function blades(c, r, x, y, w, h, n, cols, S) {
  c.lineWidth = Math.max(1, S * 0.03);
  c.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const bx = x + r() * w;
    const by = y + r() * h;
    c.strokeStyle = cols[(r() * cols.length) | 0];
    c.beginPath();
    c.moveTo(bx, by);
    c.lineTo(bx + (r() - 0.5) * S * 0.12, by - S * (0.08 + r() * 0.12));
    c.stroke();
  }
}

// Builds the static field art for a location once; traffic and hoppers draw on top.
function buildBG(li, S, dpr) {
  const loc = LOCS[li % LOCS.length];
  const r = mulberry32(1234 + li * 77);
  const cv = document.createElement("canvas");
  cv.width = Math.round(COLS * S * dpr);
  cv.height = Math.round(ROWS * S * dpr);
  const c = cv.getContext("2d");
  c.scale(dpr, dpr);
  const W = COLS * S;

  for (let row = 0; row < ROWS; row++) {
    const y = row * S;
    const type = ROWTYPE[row];
    if (type === "lane") {
      c.fillStyle = loc.laneCol;
      c.fillRect(0, y, W, S);
      if (li === 3) {
        // kitchen tile checker
        for (let cx = 0; cx < COLS * 2; cx++)
          for (let cy = 0; cy < 2; cy++) {
            if ((cx + cy + row) % 2) {
              c.fillStyle = "rgba(60,55,40,.28)";
              c.fillRect(cx * S * 0.5, y + cy * S * 0.5, S * 0.5, S * 0.5);
            }
          }
        c.strokeStyle = "rgba(0,0,0,.22)";
        c.lineWidth = 1;
        for (let cx = 0; cx <= COLS * 2; cx++) {
          c.beginPath();
          c.moveTo(cx * S * 0.5, y);
          c.lineTo(cx * S * 0.5, y + S);
          c.stroke();
        }
      } else {
        speck(c, r, 0, y, W, S, 160, loc.laneSpeck, Math.max(1.5, S * 0.035));
      }
      if (li === 0) {
        // puddles in the mud
        for (let i = 0; i < 2; i++) {
          c.fillStyle = "rgba(90,130,170,.55)";
          ell(c, r() * W, y + S * (0.25 + r() * 0.5), S * (0.4 + r() * 0.3), S * 0.12);
          c.fillStyle = "rgba(200,230,255,.25)";
          ell(c, r() * W, y + S * 0.5, S * 0.2, S * 0.04);
        }
      }
      if (li === 2) {
        // oil stains and lane paint
        c.fillStyle = "rgba(0,0,0,.28)";
        ell(c, r() * W, y + S * 0.5, S * 0.5, S * 0.16);
        c.strokeStyle = "rgba(255,200,40,.55)";
        c.lineWidth = Math.max(2, S * 0.04);
        c.setLineDash([S * 0.45, S * 0.35]);
        c.beginPath();
        c.moveTo(0, y + S);
        c.lineTo(W, y + S);
        c.stroke();
        c.setLineDash([]);
      }
      if (li === 1) {
        // straw
        c.strokeStyle = "rgba(220,190,90,.5)";
        c.lineWidth = 1.5;
        for (let i = 0; i < 34; i++) {
          const sx = r() * W;
          const sy = y + r() * S;
          c.beginPath();
          c.moveTo(sx, sy);
          c.lineTo(sx + S * 0.2, sy + (r() - 0.5) * S * 0.06);
          c.stroke();
        }
      }
    } else if (type === "safe" || type === "start") {
      c.fillStyle = loc.safeCol;
      c.fillRect(0, y, W, S);
      if (li === 2) {
        c.fillStyle = type === "start" ? "#4e5256" : "#6a6e72";
        c.fillRect(0, y, W, S);
        speck(c, r, 0, y, W, S, 120, loc.blade, Math.max(1.5, S * 0.03));
        c.fillStyle = "#8d9296";
        c.fillRect(0, y, W, Math.max(3, S * 0.07));
        c.fillRect(0, y + S - Math.max(3, S * 0.07), W, Math.max(3, S * 0.07));
      } else if (li === 3) {
        for (let p = 0; p < 4; p++) {
          c.fillStyle = p % 2 ? "#845530" : "#8f5c33";
          c.fillRect(0, y + p * S * 0.25, W, S * 0.25);
          c.fillStyle = "rgba(0,0,0,.35)";
          c.fillRect(0, y + p * S * 0.25, W, 1.5);
        }
        speck(c, r, 0, y, W, S, 60, ["#5a371c", "#a06a3a"], Math.max(1.5, S * 0.03));
      } else {
        blades(c, r, 0, y, W, S, 260, loc.blade, S);
        if (li === 0 && type === "safe") {
          // tomato plants and cabbages in the rows
          for (let i = 0; i < 3; i++) {
            const cx = (0.6 + r() * (COLS - 1.2)) * S;
            c.fillStyle = "#2e6b2a";
            ell(c, cx, y + S * 0.55, S * 0.22, S * 0.2);
            c.fillStyle = i % 2 ? "#d33a2a" : "#8fd36a";
            ell(c, cx + S * 0.08, y + S * 0.55, S * 0.08, S * 0.08);
            ell(c, cx - S * 0.1, y + S * 0.5, S * 0.07, S * 0.07);
          }
        }
        if (li === 1 && type === "safe") {
          for (let i = 0; i < 2; i++) {
            const bx = (0.5 + r() * (COLS - 2)) * S;
            c.fillStyle = "#c9a64a";
            rrect(c, bx, y + S * 0.3, S * 0.8, S * 0.42, 3);
            c.strokeStyle = "#8a6c22";
            c.lineWidth = 1.5;
            c.beginPath();
            c.moveTo(bx + S * 0.27, y + S * 0.3);
            c.lineTo(bx + S * 0.27, y + S * 0.72);
            c.moveTo(bx + S * 0.54, y + S * 0.3);
            c.lineTo(bx + S * 0.54, y + S * 0.72);
            c.stroke();
          }
        }
      }
      if (type === "start") {
        c.fillStyle = "rgba(255,194,26,.9)";
        c.fillRect(0, y, W, Math.max(3, S * 0.06));
        c.fillStyle = "rgba(0,0,0,.4)";
        c.font = "700 " + Math.round(S * 0.3) + "px 'Saira Stencil One', Impact, sans-serif";
        c.textAlign = "center";
        c.fillText("START", W * 0.5, y + S * 0.9);
      }
    } else if (type === "goal") {
      c.fillStyle = loc.goalCol;
      c.fillRect(0, y, W, S);
      if (li === 0) {
        blades(c, r, 0, y, W, S, 200, ["#2e5a1e", "#173510"], S);
        c.fillStyle = "#5a4028";
        for (let i = 0; i < 12; i++) rrect(c, i * S * 0.78, y, S * 0.5, S * 0.55, 2);
      } else if (li === 1) {
        for (let i = 0; i < 18; i++) {
          c.fillStyle = i % 2 ? "#7a2a1c" : "#6b2418";
          c.fillRect(i * S * 0.5, y, S * 0.5, S);
          c.fillStyle = "rgba(0,0,0,.35)";
          c.fillRect(i * S * 0.5, y, 1.5, S);
        }
      } else if (li === 2) {
        for (let cy = 0; cy < 4; cy++)
          for (let cx = 0; cx < 14; cx++) {
            c.fillStyle = (cx + cy) % 2 ? "#8a4a30" : "#7a3e28";
            c.fillRect(cx * S * 0.66 + (cy % 2) * S * 0.33, y + cy * S * 0.25, S * 0.64, S * 0.23);
          }
      } else {
        c.fillStyle = "#9fc4d6";
        rrect(c, S * 0.4, y + S * 0.05, W - S * 0.8, S * 0.5, 4);
        c.fillStyle = "#d8d2c0";
        c.fillRect(0, y + S * 0.62, W, S * 0.38);
        c.strokeStyle = "#5a5a52";
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(W * 0.5, y + S * 0.05);
        c.lineTo(W * 0.5, y + S * 0.55);
        c.stroke();
      }
      // finish flowers
      const n = COLS;
      for (let i = 0; i < n; i++) {
        const fx = (i + 0.5) * S;
        c.strokeStyle = "#2a5a1e";
        c.lineWidth = Math.max(2, S * 0.05);
        c.beginPath();
        c.moveTo(fx, y + S);
        c.lineTo(fx, y + S * 0.5);
        c.stroke();
        c.fillStyle = "#2e6b2a";
        ell(c, fx - S * 0.12, y + S * 0.82, S * 0.12, S * 0.05, -0.5);
        ell(c, fx + S * 0.12, y + S * 0.78, S * 0.12, S * 0.05, 0.5);
        drawSunflower(c, fx, y + S * 0.42, S * 0.22, i * 0.6);
      }
      c.fillStyle = "rgba(0,0,0,.35)";
      c.fillRect(0, y + S - 3, W, 3);
    }
  }


  // Overgrown copper-garden pass: timber beds, mixed vegetables and rainwater.
  if (li === 0) {
    const gr = mulberry32(90421);
    const wood = "#62442d";
    const woodLight = "#99704a";
    const soil = "#39291e";

    for (let row = 1; row < ROWS - 1; row++) {
      const type = ROWTYPE[row];
      const y = row * S;

      if (type === "safe") {
        const inset = S * (0.12 + gr() * 0.08);
        const bedY = y + S * 0.14;
        const bedH = S * 0.68;

        c.fillStyle = "rgba(8,7,5,.32)";
        c.fillRect(inset + 2, bedY + 4, W - inset * 2, bedH);

        c.fillStyle = wood;
        c.fillRect(inset, bedY, W - inset * 2, bedH);
        c.fillStyle = woodLight;
        c.fillRect(inset, bedY, W - inset * 2, Math.max(2, S * .055));
        c.fillStyle = "#302219";
        c.fillRect(inset, bedY + bedH - S * .09, W - inset * 2, S * .09);

        c.fillStyle = soil;
        c.fillRect(inset + S * .10, bedY + S * .10,
          W - inset * 2 - S * .20, bedH - S * .20);

        c.strokeStyle = "rgba(147,105,65,.48)";
        c.lineWidth = Math.max(1, S * .018);
        for (let f = 0; f < 5; f++) {
          const fx = inset + S * (.35 + f * .88);
          c.beginPath();
          c.moveTo(fx, bedY + S * .16);
          c.quadraticCurveTo(fx + (gr() - .5) * S * .16,
            bedY + bedH * .5, fx + (gr() - .5) * S * .12,
            bedY + bedH - S * .15);
          c.stroke();
        }

        const count = 7 + Math.floor(gr() * 5);
        for (let i = 0; i < count; i++) {
          const px = inset + S * (.28 + gr() * (COLS - .56));
          const py = bedY + S * (.20 + gr() * .48);
          const kind = i % 4;

          if (kind === 0) {
            for (let k = 0; k < 7; k++) {
              const a = k * Math.PI * 2 / 7;
              c.fillStyle = k % 2 ? "#64834a" : "#91a96a";
              ell(c, px + Math.cos(a) * S * .075,
                py + Math.sin(a) * S * .055,
                S * .095, S * .072, a);
            }
            c.fillStyle = "#b4c28a";
            ell(c, px, py, S * .065, S * .05);
          } else if (kind === 1) {
            c.strokeStyle = "#4e7040";
            c.lineWidth = Math.max(1, S * .025);
            c.beginPath();
            c.moveTo(px - S * .12, py + S * .07);
            c.quadraticCurveTo(px, py - S * .16, px + S * .12, py + S * .06);
            c.stroke();
            for (let k = 0; k < 4; k++) {
              const lx = px + (gr() - .5) * S * .24;
              const ly = py + (gr() - .5) * S * .16;
              c.fillStyle = k % 2 ? "#567742" : "#789552";
              ell(c, lx, ly, S * .075, S * .04, gr() * 2);
            }
            c.fillStyle = "#a84332";
            ell(c, px - S * .055, py + S * .07, S * .045, S * .045);
            c.fillStyle = "#c65d3d";
            ell(c, px + S * .055, py + S * .04, S * .043, S * .043);
          } else if (kind === 2) {
            c.fillStyle = "#cf8746";
            c.beginPath();
            c.moveTo(px - S * .045, py - S * .015);
            c.lineTo(px + S * .045, py - S * .015);
            c.lineTo(px + S * .01, py + S * .15);
            c.lineTo(px - S * .018, py + S * .15);
            c.closePath();
            c.fill();
            c.strokeStyle = "#78945a";
            c.lineWidth = Math.max(1, S * .018);
            for (let k = 0; k < 3; k++) {
              c.beginPath();
              c.moveTo(px, py);
              c.lineTo(px + (k - 1) * S * .07, py - S * (.10 + gr() * .06));
              c.stroke();
            }
          } else {
            c.strokeStyle = "#526e3b";
            c.lineWidth = Math.max(1, S * .025);
            c.beginPath();
            c.moveTo(px - S * .12, py + S * .05);
            c.quadraticCurveTo(px, py - S * .04, px + S * .13, py + S * .07);
            c.stroke();
            c.fillStyle = "#6f8849";
            ell(c, px - S * .06, py - S * .025, S * .09, S * .055, -.4);
            ell(c, px + S * .07, py + S * .025, S * .09, S * .05, .5);
            c.fillStyle = "#a7a15d";
            ell(c, px + S * .015, py + S * .085, S * .065, S * .045, -.2);
          }
        }

        for (let i = 0; i < 24; i++) {
          const wx = gr() * W;
          const wy = y + S * (.08 + gr() * .84);
          const lean = (gr() - .5) * S * .18;
          c.strokeStyle = i % 3 ? "#526b3c" : "#7d8a4c";
          c.lineWidth = Math.max(1, S * .018);
          c.beginPath();
          c.moveTo(wx, wy + S * .07);
          c.quadraticCurveTo(wx + lean, wy,
            wx + lean * 1.4, wy - S * (.08 + gr() * .06));
          c.stroke();
          c.fillStyle = i % 2 ? "#617d45" : "#85945a";
          ell(c, wx + lean, wy - S * .055, S * .045, S * .023, lean);
        }
      }

      if (type === "lane") {
        c.strokeStyle = "rgba(14,11,8,.62)";
        c.lineWidth = S * .10;
        for (let track = 0; track < 2; track++) {
          const tx = W * (.28 + track * .43);
          c.beginPath();
          c.moveTo(tx, y + S * .05);
          c.quadraticCurveTo(tx + S * .13, y + S * .48,
            tx - S * .04, y + S * .96);
          c.stroke();
        }

        for (let p = 0; p < 3; p++) {
          const px = S * (.65 + gr() * (COLS - 1.3));
          const py = y + S * (.25 + gr() * .5);
          const rx = S * (.22 + gr() * .28);
          const ry = S * (.07 + gr() * .045);

          c.fillStyle = "rgba(12,10,8,.68)";
          ell(c, px, py + S * .025, rx * 1.12, ry * 1.28, (gr() - .5) * .2);
          c.fillStyle = "#263a3b";
          ell(c, px, py, rx, ry, (gr() - .5) * .2);
          c.fillStyle = "#3e6260";
          ell(c, px - rx * .12, py - ry * .12, rx * .72, ry * .48);
          c.strokeStyle = "rgba(210,204,174,.52)";
          c.lineWidth = Math.max(1, S * .018);
          c.beginPath();
          c.moveTo(px - rx * .45, py - ry * .22);
          c.quadraticCurveTo(px - rx * .12, py - ry * .62,
            px + rx * .30, py - ry * .28);
          c.stroke();
          c.strokeStyle = "rgba(189,123,69,.62)";
          c.beginPath();
          c.moveTo(px + rx * .08, py + ry * .24);
          c.lineTo(px + rx * .34, py + ry * .12);
          c.stroke();
        }

        for (let i = 0; i < 18; i++) {
          const edge = gr() < .5 ? S * .12 : W - S * .12;
          const wx = edge + (gr() - .5) * S * .28;
          const wy = y + gr() * S;
          c.strokeStyle = "#667d45";
          c.lineWidth = Math.max(1, S * .02);
          c.beginPath();
          c.moveTo(wx, wy);
          c.lineTo(wx + (gr() - .5) * S * .12,
            wy - S * (.07 + gr() * .07));
          c.stroke();
        }
      }
    }

    c.strokeStyle = "rgba(189,123,69,.38)";
    c.lineWidth = Math.max(1, S * .012);
    for (let row = 0; row < ROWS; row++) {
      if (ROWTYPE[row] !== "safe") continue;
      const yy = row * S + S * .14;
      c.beginPath();
      c.moveTo(S * .16, yy);
      c.lineTo(W - S * .16, yy);
      c.stroke();
    }
  }

  // vignette and grime
  const g = c.createRadialGradient(W / 2, (ROWS * S) / 2, S * 2, W / 2, (ROWS * S) / 2, S * 7);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,.5)");
  c.fillStyle = g;
  c.fillRect(0, 0, W, ROWS * S);
  return cv;
}

if (typeof module !== "undefined") {
  module.exports = { COLS, ROWS, ROWTYPE, LANEROWS, LOCS, SP_DEF, PERIOD, MARGIN, buildTraffic, itemX, laneHit, mulberry32 };
}
