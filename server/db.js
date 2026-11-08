"use strict";
// ---------------------------------------------------------------------------
// DATABASE LAYER
//
// The website works with NO database (in-memory fallback) or with PostgreSQL (Supabase / Neon / Render).
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const memory = { alerts: [], briefings: [], actions: [] };
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

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8")); } catch (e) { return null; }
}
async function getValidation() { return readJson("validation.json"); }
async function getBacktest() { return readJson("backtest.json"); }

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
};
