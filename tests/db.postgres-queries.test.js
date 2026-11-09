"use strict";
// No PostgreSQL server is available in CI/sandbox, so this test drives server/db.js in
// "postgres" mode with a recording fake `pg` Pool. It verifies, for every dataset query:
//   * placeholder count matches the parameter count (no $n mismatch),
//   * queries are parameterised (no user value is concatenated into SQL),
//   * every read/delete is scoped by user_id (the direct pg connection bypasses RLS),
//   * saving is one transaction (BEGIN ... COMMIT) and rolls back on failure.
// It does NOT prove the SQL runs on a real database. See docs/TESTING.md.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const log = [];
let script = () => ({ rows: [], rowCount: 0 });
const fakePool = class {
  constructor() {}
  async query(sql, params) { log.push({ sql, params: params || [] }); return script(sql, params || []); }
  async connect() { return { query: async (sql, params) => { log.push({ sql, params: params || [] }); return script(sql, params || []); }, release() {} }; }
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === "pg" ? { Pool: fakePool } : origLoad.call(this, req, ...rest); };
process.env.DATABASE_URL = "postgres://fake";
delete require.cache[require.resolve("../server/db.js")];
const db = require("../server/db.js");
const csv = require("../server/csv.js");
const S = require("../public/scoring.js");
const { makeCsv } = require("./helpers");

function maxPlaceholder(sql) { let m = 0; sql.replace(/\$(\d+)/g, (_, n) => { m = Math.max(m, +n); }); return m; }
function sample() {
  const text = makeCsv(2, () => [34, 31, 11, 0.46, 0.6]);
  const v = csv.validateCsv(text);
  return { name: "t", filename: "t.csv", sha256: csv.sha256(text), rows: v.rows, dates: v.dates, forecast: csv.buildForecast(v.rows, v.dates) };
}

test.before(async () => { await db.init(); assert.strictEqual(db.status().mode, "postgres"); });
test.after(() => { Module._load = origLoad; });

test("saveDataset: one transaction, parameterised, every statement bound to the right user", async () => {
  log.length = 0;
  script = (sql) => {
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
    if (/INSERT INTO datasets/.test(sql)) return { rows: [{ id: "11111111-1111-1111-1111-111111111111", uploaded_at: new Date() }] };
    if (/INSERT INTO forecast_runs/.test(sql)) return { rows: [{ id: "22222222-2222-2222-2222-222222222222", run_at: new Date() }] };
    return { rows: [], rowCount: 0 };
  };
  const out = await db.saveDataset({ id: "user-a", email: "a@x" }, sample());
  assert.strictEqual(out.id, "11111111-1111-1111-1111-111111111111");
  const sqls = log.map((l) => l.sql.trim().split(/\s+/)[0] + " " + (l.sql.match(/(?:INTO|FROM)\s+(\w+)/) || [])[1]);
  assert.strictEqual(log[0].sql, "BEGIN");
  assert.strictEqual(log[log.length - 1].sql, "COMMIT");
  assert.ok(sqls.some((s) => /INSERT datasets/.test(s)) && sqls.some((s) => /INSERT dataset_observations/.test(s)) && sqls.some((s) => /INSERT forecast_runs/.test(s)) && sqls.some((s) => /INSERT forecast_run_outputs/.test(s)));
  for (const l of log) assert.strictEqual(maxPlaceholder(l.sql), l.params.length, "placeholder/param mismatch in: " + l.sql.slice(0, 80));
  assert.strictEqual(log.find((l) => /INSERT INTO datasets/.test(l.sql)).params[0], "user-a");
  assert.strictEqual(log.find((l) => /INSERT INTO forecast_runs/.test(l.sql)).params[1], "user-a");
  const obs = log.find((l) => /INSERT INTO dataset_observations/.test(l.sql));
  assert.strictEqual(obs.params[1].length, 48);
  const outs = log.find((l) => /INSERT INTO forecast_run_outputs/.test(l.sql));
  assert.strictEqual(outs.params[1].length, 48);
  assert.ok(outs.params[3].every((x) => Number.isInteger(x) && x >= 0 && x <= 100));
});

test("saveDataset: rolls back when the per-user cap is reached", async () => {
  log.length = 0;
  script = (sql) => (/count\(\*\)/.test(sql) ? { rows: [{ n: db.MAX_DATASETS_PER_USER }] } : { rows: [], rowCount: 0 });
  await assert.rejects(() => db.saveDataset({ id: "user-a" }, sample()), (e) => e.status === 409);
  assert.ok(log.some((l) => l.sql === "ROLLBACK"));
  assert.ok(!log.some((l) => l.sql === "COMMIT"));
  assert.ok(!log.some((l) => /INSERT INTO datasets/.test(l.sql)));
});

test("saveDataset: rolls back on a mid-transaction database error", async () => {
  log.length = 0;
  script = (sql) => {
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
    if (/INSERT INTO datasets/.test(sql)) return { rows: [{ id: "11111111-1111-1111-1111-111111111111", uploaded_at: new Date() }] };
    if (/INSERT INTO dataset_observations/.test(sql)) throw new Error("boom");
    return { rows: [], rowCount: 0 };
  };
  await assert.rejects(() => db.saveDataset({ id: "user-a" }, sample()), /boom/);
  assert.ok(log.some((l) => l.sql === "ROLLBACK"));
  assert.ok(!log.some((l) => l.sql === "COMMIT"));
});

test("read/list/delete queries are always scoped by the requesting user's id", async () => {
  log.length = 0;
  script = () => ({ rows: [{ id: "x", name: "n", dateStart: "2026-11-10", dateEnd: "2026-11-11", rowCount: 1 }], rowCount: 1 });
  await db.listDatasets("user-a");
  await db.getDataset("user-a", "11111111-1111-1111-1111-111111111111");
  await db.deleteDataset("user-a", "11111111-1111-1111-1111-111111111111");
  assert.ok(log.length >= 4);
  for (const l of log) {
    assert.strictEqual(maxPlaceholder(l.sql), l.params.length, "placeholder mismatch: " + l.sql.slice(0, 60));
    assert.match(l.sql, /user_id\s*=\s*\$\d|ds\.user_id\s*=\s*\$\d|fr\.user_id\s*=\s*\$\d/, "query is not user-scoped: " + l.sql.slice(0, 90));
    assert.ok(l.params.includes("user-a"), "user id must be a bound parameter");
    assert.ok(!l.sql.includes("user-a"), "user id must never be concatenated into SQL");
  }
});

test("a user id with SQL metacharacters is only ever passed as a bound parameter", async () => {
  log.length = 0; script = () => ({ rows: [], rowCount: 0 });
  const evil = "x'; DROP TABLE datasets; --";
  await db.listDatasets(evil); await db.getDataset(evil, "11111111-1111-1111-1111-111111111111"); await db.deleteDataset(evil, "11111111-1111-1111-1111-111111111111");
  for (const l of log) { assert.ok(!l.sql.includes("DROP"), l.sql.slice(0, 80)); assert.ok(l.params.includes(evil)); }
});

test("getDataset returns null (not another user's data) when the scoped query finds nothing", async () => {
  script = () => ({ rows: [], rowCount: 0 });
  assert.strictEqual(await db.getDataset("user-b", "11111111-1111-1111-1111-111111111111"), null);
  assert.strictEqual(await db.deleteDataset("user-b", "11111111-1111-1111-1111-111111111111"), false);
});
