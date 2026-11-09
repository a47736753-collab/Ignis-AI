"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

require("./server/env").load();
const groq = require("./server/groq");
const db = require("./server/db");
const csv = require("./server/csv");
const scoring = require("./public/scoring.js");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.resolve(__dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// Per-IP rate limit for AI routes (20 requests per minute)
function makeLimiter(max) {
  const buckets = new Map();
  return function (ip) {
    const now = Date.now();
    const b = (buckets.get(ip) || []).filter((t) => now - t < 60000);
    if (b.length >= max) {
      buckets.set(ip, b);
      return false;
    }
    b.push(now);
    buckets.set(ip, b);
    if (buckets.size > 5000) buckets.clear();
    return true;
  };
}
const allow = makeLimiter(20);
const allowUpload = makeLimiter(Number(process.env.UPLOAD_RATE_LIMIT) || 30); // CSV validate/upload per minute per IP (default 30)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function send(res, status, obj) {
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (status === 413) h.Connection = "close";
  res.writeHead(status, h);
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on("data", (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(new Error("Request too large."), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(Object.assign(new Error("Body must be valid JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function requireUser(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(\S{1,8192})$/i);
  if (!match) throw Object.assign(new Error("Sign in to access saved records."), { status: 401 });

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw Object.assign(new Error("Supabase authentication is not configured."), { status: 503 });
  }

  let response;
  try {
    response = await fetch(supabaseUrl.replace(/\/$/, "") + "/auth/v1/user", {
      headers: { apikey: anonKey, Authorization: "Bearer " + match[1] },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw Object.assign(new Error("Could not verify the sign-in session."), { status: 503 });
  }
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("Sign-in session is invalid or expired."), { status: 401 });
  }
  if (!response.ok) {
    throw Object.assign(new Error("Could not verify the sign-in session."), { status: 502 });
  }

  const user = await response.json();
  if (!user || typeof user.id !== "string" || !user.id) {
    throw Object.assign(new Error("Sign-in session did not identify a user."), { status: 401 });
  }
  return { id: user.id, email: typeof user.email === "string" ? user.email : null };
}

function checkAlerts(body) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!body || !Array.isArray(body.alerts) || body.alerts.length > 50) throw bad("Invalid alerts.");
  return body.alerts.map((a) => {
    const day = Number(a && a.day),
      score = Number(a && a.score),
      zoneId = String((a && a.zoneId) || "");
    if (!/^[A-Z][0-9]{1,2}$/.test(zoneId) || !(day >= 1 && day <= 7) || !(score >= 0 && score <= 100))
      throw bad("Invalid alert values.");
    return { zoneId, day, score };
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  // Configuration check (including public Supabase config if present)
  if (req.method === "GET" && p === "/api/config") {
    return send(res, 200, {
      groq: !!process.env.GROQ_API_KEY,
      groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      db: db.status().mode === "postgres",
      dbMode: db.status().mode,
      csv: { maxBytes: csv.LIMITS.maxBytes, maxRows: csv.LIMITS.maxRows },
      supabaseUrl: process.env.SUPABASE_URL || "",
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    });
  }

  // AI 1: Single zone risk explanation
  if (req.method === "POST" && p === "/api/ai-explain") {
    if (!allow(req.socket.remoteAddress || "local"))
      return send(res, 429, { error: "Too many requests. Wait a minute and try again." });
    const body = await readBody(req, 12 * 1024);
    return send(res, 200, await groq.explain(body));
  }

  // AI 2: Tactical Operational Briefing Generator
  if (req.method === "POST" && p === "/api/ai-briefing") {
    if (!allow(req.socket.remoteAddress || "local"))
      return send(res, 429, { error: "Too many requests. Wait a minute and try again." });
    const body = await readBody(req, 20 * 1024);
    return send(res, 200, await groq.briefing(body));
  }

  // AI 3: Interactive Commander Chat Assistant
  if (req.method === "POST" && p === "/api/ai-chat") {
    if (!allow(req.socket.remoteAddress || "local"))
      return send(res, 429, { error: "Too many requests. Wait a minute and try again." });
    const body = await readBody(req, 15 * 1024);
    return send(res, 200, await groq.chat(body));
  }

  // ---- CSV observation datasets -------------------------------------------------
  if (p === "/api/datasets/schema" && req.method === "GET") {
    return send(res, 200, {
      columns: scoring.OBS_COLUMNS, zoneIds: scoring.ZONE_IDS, limits: csv.LIMITS,
      engine: { version: scoring.ENGINE_VERSION, weights: scoring.WEIGHTS, thresholds: { high: scoring.THRESH_HIGH, med: scoring.THRESH_MED }, normalisation: scoring.NORMALISATION },
      rules: ["One row per zone per date (final observed values; no demo offsets are added).", "Every zone A1 to D6 must appear for every date.", "1 to 7 consecutive dates.", "No missing, non-numeric, out-of-range or duplicate values."],
    });
  }
  if (p === "/api/datasets/validate" && req.method === "POST") {
    if (!allowUpload(req.socket.remoteAddress || "local")) return send(res, 429, { error: "Too many uploads. Wait a minute and try again." });
    const body = await readBody(req, csv.LIMITS.maxBytes * 2 + 4096);
    const v = csv.validateCsv(body && body.csv);
    if (!v.ok) return send(res, 200, { ok: false, errors: v.errors, totalErrors: v.totalErrors, warnings: v.warnings });
    return send(res, 200, {
      ok: true, errors: [], totalErrors: 0, warnings: v.warnings, summary: v.summary, dates: v.dates,
      name: csv.cleanDatasetName(body.filename), preview: csv.publicRows(v.rows).slice(0, 12),
    });
  }
  if (p === "/api/datasets" && req.method === "POST") {
    if (!allowUpload(req.socket.remoteAddress || "local")) return send(res, 429, { error: "Too many uploads. Wait a minute and try again." });
    // A present Authorization header must be valid (never silently downgrade a signed-in user to guest).
    const user = req.headers.authorization ? await requireUser(req) : null;
    const body = await readBody(req, csv.LIMITS.maxBytes * 2 + 4096);
    const v = csv.validateCsv(body && body.csv);
    if (!v.ok) return send(res, 422, { ok: false, error: "The CSV did not pass validation.", errors: v.errors, totalErrors: v.totalErrors });
    const forecast = csv.buildForecast(v.rows, v.dates);
    const name = csv.cleanDatasetName(body.filename);
    let saved = null;
    if (user) saved = await db.saveDataset(user, { name, filename: name, sha256: csv.sha256(body.csv), rows: v.rows, dates: v.dates, forecast });
    const scores = {};
    Object.keys(forecast.byZone).forEach((z) => { scores[z] = forecast.byZone[z].map((f) => f.score); });
    return send(res, 200, {
      ok: true,
      dataset: { id: saved ? saved.id : null, saved: !!saved, name, source: "user-upload", uploadedAt: saved ? saved.uploadedAt : new Date().toISOString(), rowCount: v.rows.length, dates: v.dates, dateStart: v.dates[0], dateEnd: v.dates[v.dates.length - 1], sha256: csv.sha256(body.csv) },
      observations: csv.publicRows(v.rows),
      forecast: { engine: forecast.engine, scores, perDay: forecast.perDay, highZoneCount: forecast.highZoneCount, dates: v.dates },
      note: saved ? "Dataset saved to your account." : "Guest session: this dataset is used for this session only and is not saved. Sign in to keep it.",
    });
  }
  if (p === "/api/datasets" && req.method === "GET") {
    const user = await requireUser(req);
    return send(res, 200, { datasets: await db.listDatasets(user.id) });
  }
  {
    const m = p.match(/^\/api\/datasets\/([^/]+)$/);
    if (m && (req.method === "GET" || req.method === "DELETE")) {
      const user = await requireUser(req);
      if (!UUID_RE.test(m[1])) return send(res, 404, { error: "Dataset not found." });
      if (req.method === "DELETE") {
        return (await db.deleteDataset(user.id, m[1])) ? send(res, 200, { deleted: true }) : send(res, 404, { error: "Dataset not found." });
      }
      const got = await db.getDataset(user.id, m[1]);
      if (!got) return send(res, 404, { error: "Dataset not found." }); // same answer for "missing" and "someone else's"
      const rows = got.rows.map((r) => ({ zone_id: r.zone_id, date: r.date, temp_c: +r.temp_c, humidity_pct: +r.humidity_pct, wind_kmh: +r.wind_kmh, ndvi: +r.ndvi, fire_history: +r.fire_history }));
      const dates = Array.from(new Set(rows.map((r) => r.date))).sort();
      const forecast = csv.buildForecast(rows, dates);
      const scores = {};
      Object.keys(forecast.byZone).forEach((z) => { scores[z] = forecast.byZone[z].map((f) => f.score); });
      return send(res, 200, {
        ok: true,
        dataset: Object.assign({ saved: true, source: "user-upload", dates }, got.meta),
        observations: rows,
        forecast: { engine: forecast.engine, scores, perDay: forecast.perDay, highZoneCount: forecast.highZoneCount, dates },
        storedRun: got.run, storedScoresMatch: got.scores ? JSON.stringify(got.scores) === JSON.stringify(scores) : null,
      });
    }
  }

  // Alerts persistence
  if (req.method === "POST" && p === "/api/alerts") {
    const user = await requireUser(req);
    const alerts = checkAlerts(await readBody(req, 10 * 1024));
    return send(res, 200, { saved: await db.saveAlerts(alerts, user) });
  }
  if (req.method === "GET" && p === "/api/alerts") {
    const user = await requireUser(req);
    return send(res, 200, { alerts: await db.listAlerts(user.id) });
  }

  // Alert acknowledgment
  if (req.method === "POST" && p === "/api/alerts/ack") {
    const user = await requireUser(req);
    const body = await readBody(req, 4 * 1024);
    const zoneId = String(body.zoneId || "");
    if (!/^[A-Z][0-9]{1,2}$/.test(zoneId)) return send(res, 400, { error: "Invalid zoneId." });
    const day = Number(body.day);
    if (!Number.isInteger(day) || day < 1 || day > 7) return send(res, 400, { error: "Invalid day." });
    const result = await db.ackAlert(zoneId, day, body.acknowledged, user);
    return send(res, 200, result);
  }

  // Briefings persistence
  if (req.method === "GET" && p === "/api/briefings") {
    const user = await requireUser(req);
    return send(res, 200, { briefings: await db.listBriefings(url.searchParams.get("limit") || 20, user.id) });
  }
  if (req.method === "POST" && p === "/api/briefings") {
    const user = await requireUser(req);
    const body = await readBody(req, 30 * 1024);
    if (!body || !body.content) return send(res, 400, { error: "Briefing content is required." });
    const saved = await db.saveBriefing(body, user);
    return send(res, 200, { briefing: saved });
  }

  // Incident actions / checklists log
  if (req.method === "GET" && p === "/api/actions") {
    const user = await requireUser(req);
    return send(res, 200, { actions: await db.listActions(url.searchParams.get("limit") || 30, user.id) });
  }
  if (req.method === "POST" && p === "/api/actions") {
    const user = await requireUser(req);
    const body = await readBody(req, 10 * 1024);
    const saved = await db.logAction(body, user);
    return send(res, 200, { action: saved });
  }

  // Model evidence endpoints
  if (req.method === "GET" && p === "/api/validation") {
    const v = await db.getValidation();
    return v ? send(res, 200, v) : send(res, 404, { error: "No validation data yet." });
  }
  if (req.method === "GET" && p === "/api/backtest") {
    const b = await db.getBacktest();
    return b ? send(res, 200, b) : send(res, 404, { error: "No backtest data yet." });
  }

  return send(res, 404, { error: "Not found." });
}

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end("Bad request");
  }
  const file = path.resolve(PUBLIC, "." + (rel === "/" ? "/index.html" : rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": file.endsWith(".html") ? "no-cache" : "public, max-age=3600",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      return res.end("Method not allowed");
    }
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (!e.status) console.error("[server]", e);
    if (!res.headersSent) send(res, status, { error: e.status ? e.message : "Something went wrong on the server." });
  }
});

db.init().then(() => {
  server.listen(PORT, () => {
    console.log("\nIGNIS AI is running at http://localhost:" + PORT);
    console.log(
      "  Groq AI services: " +
        (process.env.GROQ_API_KEY
          ? "ON (model " + (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") + ")"
          : "OFF (add GROQ_API_KEY to .env)")
    );
    console.log(
      "  Database: " +
        (db.status().mode === "postgres"
          ? "PostgreSQL connected"
          : "in-memory (add DATABASE_URL to .env to use Supabase / Postgres)")
    );
    console.log(
      "  Supabase client: " +
        (process.env.SUPABASE_URL ? "Configured (" + process.env.SUPABASE_URL + ")" : "Not configured (optional)\n")
    );
  });
});
