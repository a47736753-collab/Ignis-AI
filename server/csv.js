"use strict";
// Server-side CSV parsing + validation + forecast generation for uploaded observations.
// Validation is authoritative here; the browser only previews. Nothing invalid is ever
// repaired or replaced with invented values: bad rows are reported with line numbers.
const crypto = require("crypto");
const S = require("../public/scoring.js");

const LIMITS = {
  maxBytes: Math.max(1024, Number(process.env.CSV_MAX_BYTES) || 200 * 1024),
  maxRows: Math.max(10, Number(process.env.CSV_MAX_ROWS) || 500),
  maxDays: 7,
  maxErrors: 50,
};

const REQUIRED = S.OBS_COLUMNS.map((c) => c.name);
const COL = {};
S.OBS_COLUMNS.forEach((c) => { COL[c.name] = c; });
const NUMERIC = REQUIRED.filter((n) => COL[n].engine);
const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONE_SET = new Set(S.ZONE_IDS);

function safe(s, n) {
  // Make untrusted cell text safe to echo in messages (printable, short).
  return String(s == null ? "" : s).replace(/[^\x20-\x7E]/g, "?").slice(0, n || 40);
}

// RFC 4180 style parser. Returns { records: [{line, fields[]}], error? }
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let field = "", fields = [], inQ = false, line = 1, recLine = 1, i = 0, sawAny = false;
  const n = text.length;
  function endField() { fields.push(field); field = ""; }
  function endRecord() {
    endField();
    if (!(fields.length === 1 && fields[0].trim() === "")) records.push({ line: recLine, fields });
    fields = []; sawAny = false;
  }
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      if (ch === "\n") line++;
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { inQ = true; sawAny = true; i++; continue; }
    if (ch === ",") { endField(); sawAny = true; i++; continue; }
    if (ch === "\r") { if (text[i + 1] === "\n") i++; endRecord(); line++; recLine = line; i++; continue; }
    if (ch === "\n") { endRecord(); line++; recLine = line; i++; continue; }
    field += ch; sawAny = true; i++;
  }
  if (inQ) return { records, error: "Unterminated quoted field starting near line " + recLine + "." };
  if (sawAny || field !== "" || fields.length) endRecord();
  return { records };
}

function parseDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100) return null;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return t;
}
function isoFromUTC(t) { return new Date(t).toISOString().slice(0, 10); }

function cleanDatasetName(filename) {
  let n = String(filename || "").split(/[\\/]/).pop().replace(/\.csv$/i, "");
  n = n.replace(/[^A-Za-z0-9 ._()\-]/g, "").trim().slice(0, 80);
  return n || "Uploaded dataset";
}

// Main entry. Returns { ok, errors[], totalErrors, warnings[], rows[], dates[], summary }
function validateCsv(text) {
  const errors = [];
  const warnings = [];
  let totalErrors = 0;
  function err(line, column, code, message) {
    totalErrors++;
    if (errors.length < LIMITS.maxErrors) errors.push({ line: line, column: column || null, code: code, message: message });
  }
  const fail = () => ({ ok: false, errors, totalErrors, warnings, rows: [], dates: [], summary: null, limits: LIMITS });

  if (typeof text !== "string") { err(0, null, "NOT_TEXT", "The file content must be text."); return fail(); }
  if (Buffer.byteLength(text, "utf8") > LIMITS.maxBytes) {
    err(0, null, "FILE_TOO_LARGE", "File is larger than the " + Math.round(LIMITS.maxBytes / 1024) + " KB limit.");
    return fail();
  }
  if (text.indexOf("\u0000") !== -1) { err(0, null, "NOT_CSV", "This does not look like a text CSV file (binary data found)."); return fail(); }
  if (!text.trim()) { err(0, null, "EMPTY", "The file is empty."); return fail(); }

  const parsed = parseCsv(text);
  if (parsed.error) { err(0, null, "MALFORMED_CSV", parsed.error); return fail(); }
  const recs = parsed.records;
  if (!recs.length) { err(0, null, "EMPTY", "The file has no rows."); return fail(); }

  // ---- header ----
  const header = recs[0].fields.map((h) => String(h).trim().toLowerCase());
  const idx = {};
  const seen = {};
  header.forEach((h, i) => {
    if (seen[h] !== undefined) err(1, h, "DUPLICATE_COLUMN", 'Column "' + safe(h) + '" appears more than once.');
    else seen[h] = i;
    if (COL[h] && idx[h] === undefined) idx[h] = i;
  });
  const missingCols = REQUIRED.filter((c) => idx[c] === undefined);
  if (missingCols.length) {
    err(1, null, "MISSING_COLUMNS", "Missing required column(s): " + missingCols.join(", ") + ". Required header: " + REQUIRED.join(","));
    return fail();
  }
  const extra = header.filter((h) => !COL[h] && h !== "");
  if (extra.length) warnings.push("Ignored extra column(s): " + extra.slice(0, 8).map((x) => safe(x)).join(", ") + ". Only the required columns are used.");
  if (totalErrors) return fail();

  const dataRecs = recs.slice(1);
  if (!dataRecs.length) { err(0, null, "NO_DATA_ROWS", "The file has a header but no data rows."); return fail(); }
  if (dataRecs.length > LIMITS.maxRows) {
    err(0, null, "TOO_MANY_ROWS", "File has " + dataRecs.length + " data rows; the limit is " + LIMITS.maxRows + ". A full 7-day forecast needs " + (S.ZONE_IDS.length * 7) + " rows.");
    return fail();
  }

  // ---- rows ----
  const rows = [];
  const firstSeen = new Map();
  dataRecs.forEach((r) => {
    const ln = r.line;
    if (r.fields.length !== header.length) {
      err(ln, null, "FIELD_COUNT", "Expected " + header.length + " fields but found " + r.fields.length + ".");
      return;
    }
    const get = (c) => String(r.fields[idx[c]]).trim();
    let bad = false;

    const zone = get("zone_id").toUpperCase();
    if (!zone) { err(ln, "zone_id", "MISSING_VALUE", "zone_id is empty."); bad = true; }
    else if (!ZONE_SET.has(zone)) { err(ln, "zone_id", "UNKNOWN_ZONE", 'Unknown zone "' + safe(zone, 12) + '". Valid zones are A1 to D6.'); bad = true; }

    const dateStr = get("date");
    let dateT = null;
    if (!dateStr) { err(ln, "date", "MISSING_VALUE", "date is empty."); bad = true; }
    else { dateT = parseDate(dateStr); if (dateT === null) { err(ln, "date", "INVALID_DATE", 'Invalid date "' + safe(dateStr, 20) + '". Use a real calendar date as YYYY-MM-DD.'); bad = true; } }

    const vals = {};
    NUMERIC.forEach((c) => {
      const raw = get(c);
      if (raw === "") { err(ln, c, "MISSING_VALUE", c + " is empty. Missing measurements are not filled in."); bad = true; return; }
      if (!NUM_RE.test(raw)) { err(ln, c, "INVALID_NUMBER", c + ' is not a number: "' + safe(raw, 20) + '".'); bad = true; return; }
      const v = Number(raw);
      if (!Number.isFinite(v)) { err(ln, c, "INVALID_NUMBER", c + ' is not a finite number: "' + safe(raw, 20) + '".'); bad = true; return; }
      const spec = COL[c];
      if (v < spec.min || v > spec.max) { err(ln, c, "OUT_OF_RANGE", c + " = " + v + " is outside the allowed range " + spec.min + " to " + spec.max + " (" + spec.unit + ")."); bad = true; return; }
      vals[c] = v;
    });
    if (bad) return;

    const key = zone + "|" + dateStr;
    if (firstSeen.has(key)) { err(ln, null, "DUPLICATE_OBSERVATION", "Duplicate observation for zone " + zone + " on " + dateStr + " (first seen on line " + firstSeen.get(key) + ")."); return; }
    firstSeen.set(key, ln);
    rows.push({ zone_id: zone, date: dateStr, _t: dateT, temp_c: vals.temp_c, humidity_pct: vals.humidity_pct, wind_kmh: vals.wind_kmh, ndvi: vals.ndvi, fire_history: vals.fire_history, line: ln });
  });
  if (totalErrors) return fail();

  // ---- date window + coverage (only meaningful once every row is valid) ----
  const times = Array.from(new Set(rows.map((r) => r._t))).sort((a, b) => a - b);
  if (times.length > LIMITS.maxDays) err(0, "date", "TOO_MANY_DATES", "File spans " + times.length + " distinct dates; a forecast window is at most " + LIMITS.maxDays + " consecutive days.");
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] !== 86400000) { err(0, "date", "DATE_GAP", "Dates must be consecutive. Gap between " + isoFromUTC(times[i - 1]) + " and " + isoFromUTC(times[i]) + "."); break; }
  }
  if (!totalErrors) {
    const have = new Set(rows.map((r) => r.zone_id + "|" + r._t));
    const missing = [];
    S.ZONE_IDS.forEach((z) => times.forEach((t) => { if (!have.has(z + "|" + t)) missing.push(z + " on " + isoFromUTC(t)); }));
    if (missing.length) {
      err(0, null, "INCOMPLETE_COVERAGE", missing.length + " zone-day observation(s) missing. Every zone A1 to D6 needs a row for every date, so uploaded data is never mixed with demo data. Missing: " + missing.slice(0, 6).join("; ") + (missing.length > 6 ? "; ..." : ""));
    }
  }
  if (totalErrors) return fail();

  const dates = times.map(isoFromUTC);
  const zoneOrder = new Map(S.ZONE_IDS.map((z, i) => [z, i]));
  rows.sort((a, b) => a._t - b._t || zoneOrder.get(a.zone_id) - zoneOrder.get(b.zone_id));
  rows.forEach((r) => { delete r._t; });
  return {
    ok: true, errors: [], totalErrors: 0, warnings, rows, dates,
    summary: { rowCount: rows.length, days: dates.length, zones: S.ZONE_IDS.length, dateStart: dates[0], dateEnd: dates[dates.length - 1] },
    limits: LIMITS,
  };
}

// Run the EXISTING engine over validated observations.
function buildForecast(rows, dates) {
  const byZone = {};
  S.ZONE_IDS.forEach((z) => { byZone[z] = new Array(dates.length); });
  const di = new Map(dates.map((d, i) => [d, i]));
  rows.forEach((r) => {
    const out = S.scoreObservation(r);
    byZone[r.zone_id][di.get(r.date)] = { date: r.date, score: out.score, severity: S.severity(out.score), contrib: out.contrib };
  });
  const perDay = dates.map((d, i) => {
    const c = { high: 0, med: 0, low: 0 };
    S.ZONE_IDS.forEach((z) => { c[byZone[z][i].severity]++; });
    return Object.assign({ date: d }, c);
  });
  const flagged = S.ZONE_IDS.filter((z) => byZone[z].some((f) => f.score >= S.THRESH_HIGH)).length;
  return { engine: S.ENGINE_VERSION, weights: S.WEIGHTS, thresholds: { high: S.THRESH_HIGH, med: S.THRESH_MED }, dates, byZone, perDay, highZoneCount: flagged };
}

function sha256(text) { return crypto.createHash("sha256").update(text, "utf8").digest("hex"); }

// Compact view of observations for API responses.
function publicRows(rows) {
  return rows.map((r) => ({ zone_id: r.zone_id, date: r.date, temp_c: r.temp_c, humidity_pct: r.humidity_pct, wind_kmh: r.wind_kmh, ndvi: r.ndvi, fire_history: r.fire_history }));
}

module.exports = { LIMITS, REQUIRED, parseCsv, validateCsv, buildForecast, cleanDatasetName, sha256, publicRows };
