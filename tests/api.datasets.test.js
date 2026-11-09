"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const S = require("../public/scoring.js");
const { startApp, makeCsv, api, HEADER } = require("./helpers");

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app && app.stop());

const flat = (t, h, w, n, f) => () => [t, h, w, n, f];

test("config exposes CSV limits and scoring.js is served to the browser", async () => {
  const c = await api(app.base, "GET", "/api/config");
  assert.strictEqual(c.status, 200);
  assert.ok(c.body.csv.maxBytes > 0 && c.body.csv.maxRows > 0);
  const r = await fetch(app.base + "/scoring.js");
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /IgnisScoring/);
});

test("schema endpoint reports real engine columns, weights and thresholds", async () => {
  const r = await api(app.base, "GET", "/api/datasets/schema");
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.columns.map((c) => c.name), ["zone_id", "date", "temp_c", "humidity_pct", "wind_kmh", "ndvi", "fire_history"]);
  assert.strictEqual(r.body.engine.weights.hum, 0.26);
  assert.strictEqual(r.body.zoneIds.length, 24);
});

test("validate accepts a valid 3-day file and returns a preview", async () => {
  const r = await api(app.base, "POST", "/api/datasets/validate", { filename: "my data.csv", csv: makeCsv(3, flat(34, 31, 11, 0.46, 0.6)) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.summary.rowCount, 72);
  assert.strictEqual(r.body.preview.length, 12);
  assert.strictEqual(r.body.name, "my data");
});

const BAD = [
  ["missing column", HEADER.replace(",wind_kmh", "") + "\nA1,2026-11-10,30,40,0.5,0.5", "MISSING_COLUMNS"],
  ["missing value", HEADER + "\nA1,2026-11-10,30,,10,0.5,0.5", "MISSING_VALUE"],
  ["non numeric", HEADER + "\nA1,2026-11-10,hot,40,10,0.5,0.5", "INVALID_NUMBER"],
  ["NaN text", HEADER + "\nA1,2026-11-10,NaN,40,10,0.5,0.5", "INVALID_NUMBER"],
  ["bad date", HEADER + "\nA1,2026-02-30,30,40,10,0.5,0.5", "INVALID_DATE"],
  ["unknown zone", HEADER + "\nZ9,2026-11-10,30,40,10,0.5,0.5", "UNKNOWN_ZONE"],
  ["humidity out of range", HEADER + "\nA1,2026-11-10,30,140,10,0.5,0.5", "OUT_OF_RANGE"],
  ["fire_history as count", HEADER + "\nA1,2026-11-10,30,40,10,0.5,3", "OUT_OF_RANGE"],
  ["negative wind", HEADER + "\nA1,2026-11-10,30,40,-5,0.5,0.5", "OUT_OF_RANGE"],
  ["duplicate", HEADER + "\nA1,2026-11-10,30,40,10,0.5,0.5\nA1,2026-11-10,31,41,11,0.5,0.5", "DUPLICATE_OBSERVATION"],
  ["wrong field count", HEADER + "\nA1,2026-11-10,30,40,10", "FIELD_COUNT"],
  ["unterminated quote", HEADER + '\n"A1,2026-11-10,30,40,10,0.5,0.5', "MALFORMED_CSV"],
  ["header only", HEADER, "NO_DATA_ROWS"],
  ["empty", "   \n", "EMPTY"],
  ["binary", "PK\u0003\u0004\u0000\u0000binary", "NOT_CSV"],
  ["incomplete coverage", HEADER + "\nA1,2026-11-10,30,40,10,0.5,0.5", "INCOMPLETE_COVERAGE"],
];
for (const [name, csv, code] of BAD) {
  test("validate rejects: " + name, async () => {
    const r = await api(app.base, "POST", "/api/datasets/validate", { filename: "x.csv", csv });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, false, "should be rejected");
    assert.ok(r.body.errors.some((e) => e.code === code), "expected " + code + " got " + JSON.stringify(r.body.errors.map((e) => e.code)));
  });
}

test("validate rejects 8 consecutive days and date gaps", async () => {
  let r = await api(app.base, "POST", "/api/datasets/validate", { csv: makeCsv(8, flat(30, 40, 10, 0.5, 0.5)) });
  assert.ok(r.body.errors.some((e) => e.code === "TOO_MANY_DATES"));
  const gap = makeCsv(1, flat(30, 40, 10, 0.5, 0.5), "2026-11-10").split("\n").concat(makeCsv(1, flat(30, 40, 10, 0.5, 0.5), "2026-11-12").split("\n").slice(1)).join("\n");
  r = await api(app.base, "POST", "/api/datasets/validate", { csv: gap });
  assert.ok(r.body.errors.some((e) => e.code === "DATE_GAP"));
});

test("errors carry line numbers and are capped", async () => {
  const lines = [HEADER]; for (let i = 0; i < 200; i++) lines.push("A1,2026-11-10,abc,40,10,0.5,0.5");
  const r = await api(app.base, "POST", "/api/datasets/validate", { csv: lines.join("\n") });
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.errors.length, 50);
  assert.ok(r.body.totalErrors >= 200);
  assert.strictEqual(r.body.errors[0].line, 2);
});

test("row limit and size limit are enforced on the server", async () => {
  const many = [HEADER]; for (let i = 0; i < 600; i++) many.push("A1,2026-11-10,30,40,10,0.5,0.5");
  let r = await api(app.base, "POST", "/api/datasets/validate", { csv: many.join("\n") });
  assert.ok(r.body.errors.some((e) => e.code === "TOO_MANY_ROWS"));
  const big = HEADER + "\n" + "A1,2026-11-10,30,40,10,0.5,0.5\n".repeat(9000);
  r = await api(app.base, "POST", "/api/datasets/validate", { csv: big });
  assert.ok(r.body.errors.some((e) => e.code === "FILE_TOO_LARGE"));
  const huge = await fetch(app.base + "/api/datasets/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv: "x".repeat(900 * 1024) }) }).catch(() => null);
  if (huge) assert.strictEqual(huge.status, 413);
});

test("malformed JSON body is a 400, not a crash", async () => {
  const r = await fetch(app.base + "/api/datasets/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.strictEqual(r.status, 400);
  const ok = await api(app.base, "GET", "/api/config");
  assert.strictEqual(ok.status, 200, "server must still be alive");
});

test("guest upload returns a forecast but is NOT saved", async () => {
  const r = await api(app.base, "POST", "/api/datasets", { filename: "guest.csv", csv: makeCsv(2, flat(34, 31, 11, 0.46, 0.6)) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.dataset.saved, false);
  assert.strictEqual(r.body.dataset.id, null);
  assert.strictEqual(r.body.dataset.source, "user-upload");
  const list = await api(app.base, "GET", "/api/datasets");
  assert.strictEqual(list.status, 401);
});

test("uploaded values drive the forecast through the existing engine (and changes in input change the output)", async () => {
  const cool = await api(app.base, "POST", "/api/datasets", { filename: "cool.csv", csv: makeCsv(1, flat(24, 70, 8, 0.72, 0.2)) });
  const hot = await api(app.base, "POST", "/api/datasets", { filename: "hot.csv", csv: makeCsv(1, flat(41, 16, 22, 0.34, 0.85)) });
  assert.strictEqual(cool.body.forecast.scores.A1[0], S.scoreFrom(24, 70, 8, 0.72, 0.2).score);
  assert.strictEqual(hot.body.forecast.scores.A1[0], S.scoreFrom(41, 16, 22, 0.34, 0.85).score);
  assert.ok(hot.body.forecast.scores.A1[0] > cool.body.forecast.scores.A1[0] + 40);
  assert.strictEqual(hot.body.forecast.highZoneCount, 24);
  assert.strictEqual(cool.body.forecast.highZoneCount, 0);
});

test("per-zone/day values are scored exactly as given: no demo offsets, no mixing", async () => {
  const csv = makeCsv(3, (z, d) => [30 + d * 2, 50 - d * 3, 10 + d, 0.5 - d * 0.02, 0.4]);
  const r = await api(app.base, "POST", "/api/datasets", { filename: "ramp.csv", csv });
  for (let d = 0; d < 3; d++) assert.strictEqual(r.body.forecast.scores.C3[d], S.scoreFrom(30 + d * 2, 50 - d * 3, 10 + d, 0.5 - d * 0.02, 0.4).score);
  assert.deepStrictEqual(r.body.forecast.dates, ["2026-11-10", "2026-11-11", "2026-11-12"]);
});

test("round trip: demo values exported to CSV reproduce the ORIGINAL demo forecast exactly", async () => {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", "original-index.html"), "utf8");
  const code = html.slice(html.indexOf("function mulberry32"), html.indexOf("function nearest(list,x,y)")) + "\n;this.__o={ZONES,FC};";
  const ctx = {}; vm.createContext(ctx); vm.runInContext("(function(){" + code + "}).call(this)", ctx);
  const { ZONES, FC } = ctx.__o;
  const lines = [HEADER];
  for (let d = 0; d < 7; d++) for (const z of ZONES) { const f = FC[z.id][d]; const dt = new Date(Date.UTC(2026, 10, 10 + d)).toISOString().slice(0, 10); lines.push([z.id, dt, f.temp, f.hum, f.wind, f.ndvi, f.hist].join(",")); }
  const r = await api(app.base, "POST", "/api/datasets", { filename: "demo-export.csv", csv: lines.join("\n") });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  for (const z of ZONES) for (let d = 0; d < 7; d++) assert.strictEqual(r.body.forecast.scores[z.id][d], FC[z.id][d].score, z.id + " d" + d);
});

test("signed-in upload is saved and returned to its owner only", async () => {
  const csv = makeCsv(2, flat(36, 28, 14, 0.4, 0.7));
  const up = await api(app.base, "POST", "/api/datasets", { filename: "owner-a.csv", csv }, "tokA");
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.body.dataset.saved, true);
  const id = up.body.dataset.id;
  assert.match(id, /^[0-9a-f-]{36}$/);

  const listA = await api(app.base, "GET", "/api/datasets", undefined, "tokA");
  assert.strictEqual(listA.body.datasets.length, 1);
  assert.strictEqual(listA.body.datasets[0].name, "owner-a");
  const listB = await api(app.base, "GET", "/api/datasets", undefined, "tokB");
  assert.strictEqual(listB.body.datasets.length, 0, "user B must not see user A's datasets");

  const getB = await api(app.base, "GET", "/api/datasets/" + id, undefined, "tokB");
  assert.strictEqual(getB.status, 404, "user B must not read user A's dataset");
  const delB = await api(app.base, "DELETE", "/api/datasets/" + id, undefined, "tokB");
  assert.strictEqual(delB.status, 404, "user B must not delete user A's dataset");
  const getAnon = await api(app.base, "GET", "/api/datasets/" + id);
  assert.strictEqual(getAnon.status, 401);

  const getA = await api(app.base, "GET", "/api/datasets/" + id, undefined, "tokA");
  assert.strictEqual(getA.status, 200);
  assert.strictEqual(getA.body.observations.length, 48);
  assert.strictEqual(getA.body.forecast.scores.B2[1], S.scoreFrom(36, 28, 14, 0.4, 0.7).score);
  assert.strictEqual(getA.body.storedScoresMatch, true);
  assert.strictEqual(getA.body.dataset.saved, true);

  const stillThere = await api(app.base, "GET", "/api/datasets", undefined, "tokA");
  assert.strictEqual(stillThere.body.datasets.length, 1, "B's failed delete must not remove A's data");
  const delA = await api(app.base, "DELETE", "/api/datasets/" + id, undefined, "tokA");
  assert.strictEqual(delA.status, 200);
  assert.strictEqual((await api(app.base, "GET", "/api/datasets/" + id, undefined, "tokA")).status, 404);
});

test("auth is enforced: bad token on upload is 401 (never silently downgraded to guest)", async () => {
  const r = await api(app.base, "POST", "/api/datasets", { csv: makeCsv(1, flat(30, 40, 10, 0.5, 0.5)) }, "not-a-token");
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await api(app.base, "GET", "/api/datasets", undefined, "not-a-token")).status, 401);
});

test("invalid dataset ids are 404, not 500", async () => {
  for (const id of ["abc", "../../etc/passwd", "1' OR '1'='1", "00000000-0000-0000-0000-000000000000"]) {
    const r = await api(app.base, "GET", "/api/datasets/" + encodeURIComponent(id), undefined, "tokA");
    assert.strictEqual(r.status, 404, id);
  }
});

test("per-user dataset cap returns 409", async () => {
  const csv = makeCsv(1, flat(30, 40, 10, 0.5, 0.5));
  let last;
  for (let i = 0; i < 26; i++) last = await api(app.base, "POST", "/api/datasets", { filename: "cap" + i + ".csv", csv }, "tokB");
  assert.strictEqual(last.status, 409);
});

test("existing endpoints still behave: alerts need auth, validation/backtest 404 without data files", async () => {
  assert.strictEqual((await api(app.base, "GET", "/api/alerts")).status, 401);
  const a = await api(app.base, "POST", "/api/alerts", { alerts: [{ zoneId: "D5", day: 2, score: 71 }] }, "tokA");
  assert.strictEqual(a.status, 200);
  const la = await api(app.base, "GET", "/api/alerts", undefined, "tokA");
  assert.strictEqual(la.body.alerts.length, 1);
  assert.strictEqual((await api(app.base, "GET", "/api/alerts", undefined, "tokB")).body.alerts.length, 0);
  assert.strictEqual((await api(app.base, "GET", "/api/briefings", undefined, "tokB")).body.briefings.length, 0);
});

test("AI routes fail with a useful message (not a crash) when Groq is not configured", async () => {
  const r = await api(app.base, "POST", "/api/ai-explain", { zoneId: "A1", day: 1, score: 70, drivers: [{ key: "temp", pct: 40 }], conditions: { tempC: 30, humidityPct: 30, windKmh: 10, ndvi: 0.4, fireHistory: 0.5 } });
  assert.strictEqual(r.status, 503);
  assert.match(r.body.error, /Groq/);
});

test("upload rate limit returns 429 once exceeded (separate app instance, limit 5/min)", async () => {
  const a2 = await startApp({ UPLOAD_RATE_LIMIT: "5" });
  try {
    const csv = makeCsv(1, flat(30, 40, 10, 0.5, 0.5));
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await api(a2.base, "POST", "/api/datasets/validate", { csv })).status);
    assert.deepStrictEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.ok(codes.slice(5).every((c) => c === 429), JSON.stringify(codes));
  } finally { a2.stop(); }
});

test("existing briefings, actions and acknowledgements still work and stay per-user", async () => {
  const b = await api(app.base, "POST", "/api/briefings", { title: "T", threatLevel: "high", summary: "s", content: "c", actions: ["a"] }, "tokA");
  assert.strictEqual(b.status, 200);
  assert.strictEqual((await api(app.base, "GET", "/api/briefings", undefined, "tokA")).body.briefings.length, 1);
  assert.strictEqual((await api(app.base, "GET", "/api/briefings", undefined, "tokB")).body.briefings.length, 0);
  assert.strictEqual((await api(app.base, "POST", "/api/briefings", { title: "x" })).status, 401);
  const act = await api(app.base, "POST", "/api/actions", { actionType: "checklist", zoneId: "D5", payload: { step: 1 } }, "tokA");
  assert.strictEqual(act.status, 200);
  assert.strictEqual((await api(app.base, "GET", "/api/actions", undefined, "tokA")).body.actions.length, 1);
  assert.strictEqual((await api(app.base, "GET", "/api/actions", undefined, "tokB")).body.actions.length, 0);
  await api(app.base, "POST", "/api/alerts", { alerts: [{ zoneId: "D5", day: 2, score: 71 }] }, "tokA");
  const ack = await api(app.base, "POST", "/api/alerts/ack", { zoneId: "D5", day: 2, acknowledged: true }, "tokB");
  assert.strictEqual(ack.body.count, 0, "user B must not acknowledge user A's alert");
  const ackA = await api(app.base, "POST", "/api/alerts/ack", { zoneId: "D5", day: 2, acknowledged: true }, "tokA");
  assert.ok(ackA.body.count >= 1);
});

test("server still starts and works when DATABASE_URL is set but unusable (falls back to memory)", async () => {
  const a3 = await startApp({ DATABASE_URL: "postgres://u:p@127.0.0.1:1/none" });
  try {
    const c = await api(a3.base, "GET", "/api/config");
    assert.strictEqual(c.status, 200); assert.strictEqual(c.body.db, false);
    const r = await api(a3.base, "POST", "/api/datasets", { filename: "x.csv", csv: makeCsv(1, flat(30, 40, 10, 0.5, 0.5)) }, "tokA");
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.dataset.saved, true);
  } finally { a3.stop(); }
});
