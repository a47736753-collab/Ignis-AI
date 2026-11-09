"use strict";
// ---------------------------------------------------------------------------
// DATABASE LAYER
//
// The website works with NO database (in-memory fallback) or with PostgreSQL (Supabase / Neon / Render).
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.IGNIS_DATA_DIR ? path.resolve(process.env.IGNIS_DATA_DIR) : path.join(__dirname, "..", "data");
const memory = { alerts: [], briefings: [], actions: [], datasets: [] };
const crypto = require("crypto");
const MAX_DATASETS_PER_USER = 25;
let pool = null;
let mode = "memory";

async function init() {
  const url = process.env.DATABASE_URL;
  if (!url) { mode = "memory"; return; }
  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: url,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
    await pool.query("SELECT 1");
    mode = "postgres";
    console.log("[db] Connected to PostgreSQL (Supabase / Persistent Database).");
  } catch (e) {
    console.warn("[db] Could not connect via DATABASE_URL (" + e.message + "). Using in-memory storage.");
    pool = null;
    mode = "memory";
  }
}

function status() { return { mode }; }

// alerts: [{ zoneId: "D5", day: 3, score: 71 }]
async function saveAlerts(alerts, user) {
  if (mode === "postgres") {
    for (const a of alerts) {
      await pool.query(
        "INSERT INTO alerts (user_id, zone_id, days_ahead, score, acknowledged) VALUES ($1, $2, $3, $4, false)",
        [user.id, a.zoneId, a.day, a.score]
      );
    }
    return alerts.length;
  }
  const now = new Date().toISOString();
  alerts.forEach((a) => {
    memory.alerts.push({
      id: "mem_" + (memory.alerts.length + 1),
      userId: user.id,
      zoneId: a.zoneId,
      day: a.day,
      score: a.score,
      acknowledged: false,
      createdAt: now,
    });
  });
  memory.alerts = memory.alerts.slice(-500);
  return alerts.length;
}

async function listAlerts(userId) {
  if (mode === "postgres") {
    const r = await pool.query(
      'SELECT id, zone_id AS "zoneId", days_ahead AS day, score, acknowledged, acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy", created_at AS "createdAt" FROM alerts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [userId]
    );
    return r.rows;
  }
  return memory.alerts.filter((a) => a.userId === userId).slice(-100).reverse();
}

async function ackAlert(zoneId, day, acked, user) {
  const isAcked = acked !== false;
  const now = new Date().toISOString();
  const userName = (user && (user.email || user.name)) || "Officer";

  if (mode === "postgres") {
    const r = await pool.query(
      "UPDATE alerts SET acknowledged = $1, acknowledged_at = $2, acknowledged_by = $3 WHERE user_id = $4 AND zone_id = $5 AND days_ahead = $6",
      [isAcked, isAcked ? now : null, isAcked ? userName : null, user.id, zoneId, day]
    );
    return { ok: true, zoneId, day, acknowledged: isAcked, count: r.rowCount };
  }

  // Update in memory
  let matched = 0;
  memory.alerts.forEach((a) => {
    if (a.userId === user.id && a.zoneId === zoneId && a.day === day) {
      a.acknowledged = isAcked;
      a.acknowledgedAt = isAcked ? now : null;
      a.acknowledgedBy = isAcked ? userName : null;
      matched++;
    }
  });
  return { ok: true, zoneId, acknowledged: isAcked, count: matched };
}

// Briefings
async function saveBriefing(b, user) {
  const now = new Date().toISOString();
  if (mode === "postgres") {
    const r = await pool.query(
      `INSERT INTO briefings (user_id, user_email, title, threat_level, summary, content, actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at AS "createdAt"`,
      [
        user.id,
        user.email,
        b.title || "IGNIS AI 24h Operational Briefing",
        b.threatLevel || "high",
        b.summary || "",
        b.content || "",
        JSON.stringify(b.actions || []),
      ]
    );
    return r.rows[0];
  }
  const item = {
    id: "brf_" + (memory.briefings.length + 1),
    userId: user.id,
    userEmail: user.email,
    title: b.title || "IGNIS AI 24h Operational Briefing",
    threatLevel: b.threatLevel || "high",
    summary: b.summary || "",
    content: b.content || "",
    actions: b.actions || [],
    createdAt: now,
  };
  memory.briefings.push(item);
  memory.briefings = memory.briefings.slice(-100);
  return item;
}

async function listBriefings(limit, userId) {
  const lim = Math.min(Number(limit) || 20, 100);
  if (mode === "postgres") {
    const r = await pool.query(
      `SELECT id, user_id AS "userId", user_email AS "userEmail", title, threat_level AS "threatLevel",
              summary, content, actions, created_at AS "createdAt"
       FROM briefings WHERE user_id = $2 ORDER BY created_at DESC LIMIT $1`,
      [lim, userId]
    );
    return r.rows;
  }
  return memory.briefings.filter((b) => b.userId === userId).slice(-lim).reverse();
}

// Incident actions (dispatches, checklists, drills)
async function logAction(action, user) {
  const now = new Date().toISOString();
  if (mode === "postgres") {
    const r = await pool.query(
      `INSERT INTO incident_actions (user_id, action_type, zone_id, payload, performed_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at AS "createdAt"`,
      [
        user.id,
        action.actionType || "general",
        action.zoneId || null,
        JSON.stringify(action.payload || {}),
        user.email || "Officer",
      ]
    );
    return r.rows[0];
  }
  const item = {
    id: "act_" + (memory.actions.length + 1),
    userId: user.id,
    actionType: action.actionType || "general",
    zoneId: action.zoneId || null,
    payload: action.payload || {},
    performedBy: user.email || "Officer",
    createdAt: now,
  };
  memory.actions.push(item);
  memory.actions = memory.actions.slice(-200);
  return item;
}

async function listActions(limit, userId) {
  const lim = Math.min(Number(limit) || 30, 100);
  if (mode === "postgres") {
    const r = await pool.query(
      `SELECT id, action_type AS "actionType", zone_id AS "zoneId", payload, performed_by AS "performedBy",
              created_at AS "createdAt"
       FROM incident_actions WHERE user_id = $2 ORDER BY created_at DESC LIMIT $1`,
      [lim, userId]
    );
    return r.rows;
  }
  return memory.actions.filter((a) => a.userId === userId).slice(-lim).reverse();
}


// ---------------------------------------------------------------------------
// Uploaded datasets (CSV observations + forecast runs).
// SECURITY: the server connects with a direct PostgreSQL login, which BYPASSES Supabase
// Row Level Security. Ownership is therefore enforced in every query below with
// "user_id = $n" (and a JOIN to datasets for child tables). RLS policies on these tables
// are defence in depth only. Cross-user reads return null/false (looks like "not found").
// ---------------------------------------------------------------------------
// ds = { name, filename, sha256, rows:[{zone_id,date,temp_c,humidity_pct,wind_kmh,ndvi,fire_history}], dates:[], forecast }
async function saveDataset(user, ds) {
  const uploadedAt = new Date().toISOString();
  const zoneIds = Object.keys(ds.forecast.byZone);
  if (mode === "postgres") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cnt = await client.query("SELECT count(*)::int AS n FROM datasets WHERE user_id = $1", [user.id]);
      if (cnt.rows[0].n >= MAX_DATASETS_PER_USER) {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("Dataset limit reached (" + MAX_DATASETS_PER_USER + "). Delete an older dataset first."), { status: 409 });
      }
      const d = await client.query(
        `INSERT INTO datasets (user_id, name, source_label, original_filename, row_count, date_start, date_end, content_sha256)
         VALUES ($1, $2, 'user-uploaded', $3, $4, $5, $6, $7) RETURNING id, uploaded_at`,
        [user.id, ds.name, ds.filename || null, ds.rows.length, ds.dates[0], ds.dates[ds.dates.length - 1], ds.sha256]
      );
      const id = d.rows[0].id;
      await client.query(
        `INSERT INTO dataset_observations (dataset_id, zone_id, obs_date, temp_c, humidity_pct, wind_kmh, ndvi, fire_history)
         SELECT $1::uuid, * FROM unnest($2::text[], $3::date[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[])`,
        [id, ds.rows.map((r) => r.zone_id), ds.rows.map((r) => r.date), ds.rows.map((r) => r.temp_c),
          ds.rows.map((r) => r.humidity_pct), ds.rows.map((r) => r.wind_kmh), ds.rows.map((r) => r.ndvi), ds.rows.map((r) => r.fire_history)]
      );
      const run = await client.query(
        `INSERT INTO forecast_runs (dataset_id, user_id, engine_version, weights, thresholds, high_zone_count, day_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, run_at`,
        [id, user.id, ds.forecast.engine, JSON.stringify(ds.forecast.weights), JSON.stringify(ds.forecast.thresholds), ds.forecast.highZoneCount, ds.dates.length]
      );
      const outZ = [], outD = [], outS = [], outV = [], outC = [];
      zoneIds.forEach((z) => ds.forecast.byZone[z].forEach((f) => { outZ.push(z); outD.push(f.date); outS.push(f.score); outV.push(f.severity); outC.push(JSON.stringify(f.contrib)); }));
      await client.query(
        `INSERT INTO forecast_run_outputs (run_id, zone_id, target_date, score, severity, contributions)
         SELECT $1::uuid, * FROM unnest($2::text[], $3::date[], $4::int[], $5::text[], $6::jsonb[])`,
        [run.rows[0].id, outZ, outD, outS, outV, outC]
      );
      await client.query("COMMIT");
      return { id, uploadedAt: d.rows[0].uploaded_at, runId: run.rows[0].id, runAt: run.rows[0].run_at };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (e2) {}
      throw e;
    } finally {
      client.release();
    }
  }
  const mine = memory.datasets.filter((x) => x.userId === user.id);
  if (mine.length >= MAX_DATASETS_PER_USER) throw Object.assign(new Error("Dataset limit reached (" + MAX_DATASETS_PER_USER + "). Delete an older dataset first."), { status: 409 });
  const id = crypto.randomUUID();
  const scores = {};
  zoneIds.forEach((z) => { scores[z] = ds.forecast.byZone[z].map((f) => f.score); });
  memory.datasets.push({
    id, userId: user.id, name: ds.name, filename: ds.filename || null, sha256: ds.sha256, uploadedAt,
    dateStart: ds.dates[0], dateEnd: ds.dates[ds.dates.length - 1], rowCount: ds.rows.length, dates: ds.dates.slice(),
    rows: ds.rows.map((r) => Object.assign({}, r)),
    run: { id: crypto.randomUUID(), runAt: uploadedAt, engine: ds.forecast.engine, highZoneCount: ds.forecast.highZoneCount, dayCount: ds.dates.length },
    scores,
  });
  memory.datasets = memory.datasets.slice(-200);
  return { id, uploadedAt, runId: memory.datasets[memory.datasets.length - 1].run.id, runAt: uploadedAt };
}

async function listDatasets(userId) {
  if (mode === "postgres") {
    const r = await pool.query(
      `SELECT d.id, d.name, d.source_label AS "source", d.original_filename AS "filename", d.row_count AS "rowCount",
              to_char(d.date_start, 'YYYY-MM-DD') AS "dateStart", to_char(d.date_end, 'YYYY-MM-DD') AS "dateEnd",
              d.uploaded_at AS "uploadedAt", fr.high_zone_count AS "highZoneCount", fr.run_at AS "lastRunAt"
       FROM datasets d
       LEFT JOIN LATERAL (SELECT high_zone_count, run_at FROM forecast_runs WHERE dataset_id = d.id AND user_id = $1 ORDER BY run_at DESC LIMIT 1) fr ON true
       WHERE d.user_id = $1 ORDER BY d.uploaded_at DESC LIMIT 50`,
      [userId]
    );
    return r.rows;
  }
  return memory.datasets.filter((x) => x.userId === userId).slice().reverse().slice(0, 50).map((x) => ({
    id: x.id, name: x.name, source: "user-uploaded", filename: x.filename, rowCount: x.rowCount, dateStart: x.dateStart, dateEnd: x.dateEnd,
    uploadedAt: x.uploadedAt, highZoneCount: x.run.highZoneCount, lastRunAt: x.run.runAt,
  }));
}

// Returns null when the dataset does not exist OR belongs to someone else.
async function getDataset(userId, id) {
  if (mode === "postgres") {
    const d = await pool.query(
      `SELECT id, name, source_label AS "source", original_filename AS "filename", row_count AS "rowCount",
              to_char(date_start, 'YYYY-MM-DD') AS "dateStart", to_char(date_end, 'YYYY-MM-DD') AS "dateEnd",
              uploaded_at AS "uploadedAt", content_sha256 AS "sha256"
       FROM datasets WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!d.rows.length) return null;
    const o = await pool.query(
      `SELECT o.zone_id, to_char(o.obs_date, 'YYYY-MM-DD') AS date, o.temp_c, o.humidity_pct, o.wind_kmh, o.ndvi, o.fire_history
       FROM dataset_observations o JOIN datasets ds ON ds.id = o.dataset_id
       WHERE o.dataset_id = $1 AND ds.user_id = $2 ORDER BY o.obs_date, o.zone_id`,
      [id, userId]
    );
    const run = await pool.query(
      `SELECT id, run_at AS "runAt", engine_version AS "engine", high_zone_count AS "highZoneCount", day_count AS "dayCount"
       FROM forecast_runs WHERE dataset_id = $1 AND user_id = $2 ORDER BY run_at DESC LIMIT 1`,
      [id, userId]
    );
    let scores = null;
    if (run.rows.length) {
      const so = await pool.query(
        `SELECT fo.zone_id, to_char(fo.target_date, 'YYYY-MM-DD') AS date, fo.score
         FROM forecast_run_outputs fo JOIN forecast_runs fr ON fr.id = fo.run_id
         WHERE fo.run_id = $1 AND fr.user_id = $2 ORDER BY fo.target_date, fo.zone_id`,
        [run.rows[0].id, userId]
      );
      scores = {};
      so.rows.forEach((x) => { (scores[x.zone_id] = scores[x.zone_id] || []).push(x.score); });
    }
    return { meta: d.rows[0], rows: o.rows, run: run.rows[0] || null, scores };
  }
  const x = memory.datasets.find((y) => y.id === id && y.userId === userId);
  if (!x) return null;
  return {
    meta: { id: x.id, name: x.name, source: "user-uploaded", filename: x.filename, rowCount: x.rowCount, dateStart: x.dateStart, dateEnd: x.dateEnd, uploadedAt: x.uploadedAt, sha256: x.sha256 },
    rows: x.rows.map((r) => Object.assign({}, r)), run: Object.assign({}, x.run), scores: JSON.parse(JSON.stringify(x.scores)),
  };
}

async function deleteDataset(userId, id) {
  if (mode === "postgres") {
    const r = await pool.query("DELETE FROM datasets WHERE id = $1 AND user_id = $2", [id, userId]);
    return r.rowCount > 0;
  }
  const before = memory.datasets.length;
  memory.datasets = memory.datasets.filter((y) => !(y.id === id && y.userId === userId));
  return memory.datasets.length < before;
}

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8")); } catch (e) { return null; }
}
// Evidence files are validated before they are served, so a malformed or odd file can never
// show up in the UI as "measured" performance. Unknown fields are dropped.
function validValidation(v) {
  if (!v || !Array.isArray(v.labels) || !Array.isArray(v.scores)) return null;
  if (v.labels.length !== v.scores.length || v.labels.length === 0 || v.labels.length > 100000) return null;
  for (let i = 0; i < v.labels.length; i++) {
    if (v.labels[i] !== 0 && v.labels[i] !== 1) return null;
    if (typeof v.scores[i] !== "number" || !Number.isFinite(v.scores[i]) || v.scores[i] < 0 || v.scores[i] > 100) return null;
  }
  return { labels: v.labels.slice(), scores: v.scores.slice() };
}
function validBacktest(b) {
  if (!Array.isArray(b) || b.length === 0 || b.length > 50) return null;
  const str = (x, n) => (typeof x === "string" ? x.slice(0, n) : undefined);
  const out = [];
  for (const e of b) {
    if (!e || typeof e !== "object" || typeof e.name !== "string" || !e.name.trim()) return null;
    if (!Array.isArray(e.scores) || e.scores.length !== 8) return null;
    if (!e.scores.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100)) return null;
    const o = { name: e.name.slice(0, 120), zone: str(e.zone, 20) || "", scores: e.scores.slice(), note: str(e.note, 400) || "" };
    // "verified" only counts when an independent source is named
    if (e.verified === true && typeof e.source === "string" && e.source.trim()) { o.verified = true; o.source = e.source.slice(0, 200); }
    if (str(e.date, 40)) o.date = str(e.date, 40);
    if (str(e.location, 120)) o.location = str(e.location, 120);
    out.push(o);
  }
  return out;
}
async function getValidation() {
  const raw = readJson("validation.json");
  if (raw === null) return null;
  const v = validValidation(raw);
  if (!v) console.warn("[evidence] data/validation.json ignored: it must be {labels:[0|1...], scores:[0..100...]} of equal length.");
  return v;
}
async function getBacktest() {
  const raw = readJson("backtest.json");
  if (raw === null) return null;
  const b = validBacktest(raw);
  if (!b) console.warn("[evidence] data/backtest.json ignored: each entry needs a name and exactly 8 daily scores between 0 and 100.");
  return b;
}

module.exports = {
  init,
  status,
  saveAlerts,
  listAlerts,
  ackAlert,
  saveBriefing,
  listBriefings,
  logAction,
  listActions,
  getValidation,
  getBacktest,
  saveDataset,
  listDatasets,
  getDataset,
  deleteDataset,
  MAX_DATASETS_PER_USER,
};
