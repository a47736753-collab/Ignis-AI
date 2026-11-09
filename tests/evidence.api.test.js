"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startApp, api } = require("./helpers");

function tmpData(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-data-"));
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(d, n), typeof v === "string" ? v : JSON.stringify(v));
  return d;
}
// NOTE: these are TEST FIXTURES (made-up numbers) used only to exercise the validators. They are never shipped in data/.
const goodVal = { labels: [1, 0, 1, 0, 0, 1], scores: [80, 20, 70, 30, 10, 90] };
const goodBt = [{ name: "Fixture event", zone: "D5", scores: [30, 36, 44, 56, 66, 74, 81, 86], note: "n", verified: true, source: "Fixture record", date: "2026-01-01" }];

test("valid evidence files are served (and only known fields)", async () => {
  const app = await startApp({ IGNIS_DATA_DIR: tmpData({ "validation.json": goodVal, "backtest.json": Object.assign([], [Object.assign({}, goodBt[0], { evil: "<script>" })]) }) });
  try {
    const v = await api(app.base, "GET", "/api/validation"); assert.strictEqual(v.status, 200); assert.deepStrictEqual(v.body, goodVal);
    const b = await api(app.base, "GET", "/api/backtest"); assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body[0].verified, true); assert.strictEqual(b.body[0].source, "Fixture record"); assert.ok(!("evil" in b.body[0]));
  } finally { app.stop(); }
});

test("malformed evidence files are rejected, not served", async () => {
  const bad = [
    ["validation.json", { labels: [1, 0], scores: [80] }],
    ["validation.json", { labels: [2, 0], scores: [80, 20] }],
    ["validation.json", { labels: [1, 0], scores: [180, 20] }],
    ["validation.json", { labels: [1, 0], scores: ["80", 20] }],
    ["validation.json", "not json at all"],
    ["backtest.json", [{ name: "x", scores: [1, 2, 3] }]],
    ["backtest.json", [{ name: "", scores: [1, 2, 3, 4, 5, 6, 7, 8] }]],
    ["backtest.json", [{ name: "x", scores: [1, 2, 3, 4, 5, 6, 7, 800] }]],
  ];
  for (const [file, content] of bad) {
    const app = await startApp({ IGNIS_DATA_DIR: tmpData({ [file]: content }) });
    try { const r = await api(app.base, "GET", file === "validation.json" ? "/api/validation" : "/api/backtest"); assert.strictEqual(r.status, 404, file + " " + JSON.stringify(content).slice(0, 60)); } finally { app.stop(); }
  }
});

test("'verified' is dropped unless a source is named", async () => {
  const app = await startApp({ IGNIS_DATA_DIR: tmpData({ "backtest.json": [{ name: "x", scores: [1, 2, 3, 4, 5, 6, 7, 8], verified: true }] }) });
  try { const r = await api(app.base, "GET", "/api/backtest"); assert.strictEqual(r.status, 200); assert.ok(!r.body[0].verified); } finally { app.stop(); }
});

test("with no evidence files the endpoints 404 (UI then shows labelled synthetic samples)", async () => {
  const app = await startApp({ IGNIS_DATA_DIR: tmpData({}) });
  try { assert.strictEqual((await api(app.base, "GET", "/api/validation")).status, 404); assert.strictEqual((await api(app.base, "GET", "/api/backtest")).status, 404); } finally { app.stop(); }
});
