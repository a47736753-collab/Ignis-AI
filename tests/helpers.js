"use strict";
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const S = require("../public/scoring.js");

// Minimal Supabase auth mock: GET /auth/v1/user -> user by bearer token.
function startMockSupabase() {
  const users = { tokA: { id: "user-a", email: "a@example.com" }, tokB: { id: "user-b", email: "b@example.com" } };
  const srv = http.createServer((req, res) => {
    const m = (req.headers.authorization || "").match(/^Bearer (\S+)$/);
    const u = m && users[m[1]];
    if (req.url === "/auth/v1/user" && u) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(u)); }
    res.writeHead(401, { "Content-Type": "application/json" }); res.end("{}");
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: "http://127.0.0.1:" + srv.address().port })));
}

async function startApp(extraEnv) {
  const sb = await startMockSupabase();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = Object.assign({}, process.env, { PORT: String(port), SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: "anon-test", DATABASE_URL: "", GROQ_API_KEY: "", UPLOAD_RATE_LIMIT: "5000" }, extraEnv || {});
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/api/config"); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 59) throw new Error("server did not start: " + log);
  }
  return { base, stop: () => { child.kill(); sb.srv.close(); }, log: () => log };
}

const HEADER = "zone_id,date,temp_c,humidity_pct,wind_kmh,ndvi,fire_history";
function addDays(iso, n) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Build a full-grid CSV. fn(zone, dayIndex) -> [temp,hum,wind,ndvi,hist]
function makeCsv(days, fn, start) {
  const lines = [HEADER];
  for (let d = 0; d < days; d++) for (const z of S.ZONE_IDS) lines.push([z, addDays(start || "2026-11-10", d)].concat(fn(z, d)).join(","));
  return lines.join("\n");
}
async function api(base, method, url, body, token) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
module.exports = { startApp, makeCsv, api, HEADER, addDays };
