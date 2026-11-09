"use strict";
// Regression: the shared scoring module must give IDENTICAL results to the original
// implementation in the backed-up original index.html (extracted verbatim, then executed).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ORIG = process.env.IGNIS_ORIGINAL_HTML ||
  path.join(__dirname, "fixtures", "original-index.html");
const NEW = require("../public/scoring.js");

function loadOriginal() {
  const html = fs.readFileSync(ORIG, "utf8");
  // Take the original definitions verbatim from the data script (mulberry32 ... FC).
  const start = html.indexOf("function mulberry32");
  const end = html.indexOf("function nearest(list,x,y)");
  assert.ok(start > 0 && end > start, "could not locate original scoring code");
  const code = html.slice(start, end) + "\n;this.__out={scoreFrom,ZONES,FC,W,THRESH_HIGH,THRESH_MED,sev,scoreZone};";
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext("(function(){" + code + "}).call(this)", ctx);
  return ctx.__out;
}
const O = loadOriginal();

test("weights and thresholds are unchanged", () => {
  assert.strictEqual(JSON.stringify(NEW.WEIGHTS), JSON.stringify(O.W));
  assert.strictEqual(NEW.THRESH_HIGH, O.THRESH_HIGH);
  assert.strictEqual(NEW.THRESH_MED, O.THRESH_MED);
  assert.strictEqual(NEW.WEIGHTS.temp + NEW.WEIGHTS.hum + NEW.WEIGHTS.wind + NEW.WEIGHTS.ndvi + NEW.WEIGHTS.hist, 1);
});

test("scoreFrom matches the original on a dense grid (exact equality incl. contributions)", () => {
  let n = 0;
  for (let t = -10; t <= 55; t += 2.5)
    for (let h = 0; h <= 100; h += 6.25)
      for (let w = 0; w <= 60; w += 5)
        for (let nd = -0.2; nd <= 1.0001; nd += 0.1)
          for (let hi = 0; hi <= 1.0001; hi += 0.25) {
            const a = O.scoreFrom(t, h, w, nd, hi), b = NEW.scoreFrom(t, h, w, nd, hi);
            assert.strictEqual(b.score, a.score);
            for (const k of Object.keys(a.contrib)) assert.strictEqual(b.contrib[k], a.contrib[k]);
            for (const k of Object.keys(a.N)) assert.strictEqual(b.N[k], a.N[k]);
            n++;
          }
  assert.ok(n > 100000, "grid too small: " + n);
});

test("scoreFrom matches the original on 50,000 random inputs", () => {
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 50000; i++) {
    const t = -30 + rnd() * 90, h = rnd() * 100, w = rnd() * 200, nd = -1 + rnd() * 2, hi = rnd();
    const a = O.scoreFrom(t, h, w, nd, hi), b = NEW.scoreFrom(t, h, w, nd, hi);
    assert.strictEqual(b.score, a.score);
    for (const k of Object.keys(a.contrib)) assert.strictEqual(b.contrib[k], a.contrib[k]);
  }
});

test("original 24 zones x 7 days demo forecast is reproduced exactly through the shared engine", () => {
  assert.strictEqual(O.ZONES.length, 24);
  let checked = 0;
  for (const z of O.ZONES) {
    assert.ok(NEW.ZONE_IDS.includes(z.id), "zone id " + z.id + " missing from shared ZONE_IDS");
    for (let d = 0; d < 7; d++) {
      const f = O.FC[z.id][d];
      const r = NEW.scoreFrom(f.temp, f.hum, f.wind, f.ndvi, f.hist);
      assert.strictEqual(r.score, f.score, z.id + " day " + d);
      checked++;
    }
  }
  assert.strictEqual(checked, 168);
  assert.strictEqual(JSON.stringify(NEW.ZONE_IDS.slice().sort()), JSON.stringify(Array.from(O.ZONES, (z) => z.id).sort()));
});

test("severity mapping matches original sev()", () => {
  for (let s = 0; s <= 100; s++) assert.strictEqual(NEW.severity(s), O.sev(s));
});
