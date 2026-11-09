/*
 * IGNIS AI - shared scoring module (browser + Node).
 *
 * This file holds the EXISTING deterministic weighted risk formula, moved out of
 * public/index.html so the browser and the server run the exact same code.
 * The weights, normalisation bands, stretch constants and thresholds below are
 * copied unchanged from the original index.html. tests/scoring.regression.test.js
 * compares this module against the original implementation (extracted from the
 * backed-up original index.html) to prove outputs are identical.
 *
 * It is NOT a machine-learning model. Every number is an expert-set constant.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.IgnisScoring = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function clamp(x, a, b) {
    a = a === undefined ? 0 : a;
    b = b === undefined ? 1 : b;
    return Math.min(b, Math.max(a, x));
  }

  // Feature weights (sum = 1.00). Unchanged from the original engine.
  var WEIGHTS = { temp: 0.24, hum: 0.26, wind: 0.12, ndvi: 0.22, hist: 0.16 };
  var THRESH_HIGH = 65;
  var THRESH_MED = 40;
  // Final rescale constants: stretch = clamp((weightedSum - 0.26) / 0.55) * 100
  var STRETCH_OFFSET = 0.26;
  var STRETCH_SPAN = 0.55;

  // Normalisation bands (documented for the methodology section).
  var NORMALISATION = {
    temp: "clamp((temp_c - 22) / 22)",
    hum: "clamp(1 - (humidity_pct - 10) / 70)",
    wind: "clamp(wind_kmh / 40)",
    ndvi: "clamp(1 - (ndvi - 0.2) / 0.6)",
    hist: "fire_history (already 0 to 1)"
  };

  function scoreFrom(t, h, w, ndvi, hist) {
    var N = {
      temp: clamp((t - 22) / 22),
      hum: clamp(1 - (h - 10) / 70),
      wind: clamp(w / 40),
      ndvi: clamp(1 - (ndvi - 0.2) / 0.6),
      hist: hist
    };
    var c = {}, s = 0, k;
    for (k in WEIGHTS) { c[k] = WEIGHTS[k] * N[k]; s += c[k]; }
    var stretch = clamp((s - STRETCH_OFFSET) / STRETCH_SPAN) * 100;
    var scale = s > 0 ? stretch / s : 0;
    for (k in c) { c[k] = c[k] * scale; }
    return { score: Math.round(stretch), N: N, contrib: c };
  }

  function severity(score) {
    return score >= THRESH_HIGH ? "high" : score >= THRESH_MED ? "med" : "low";
  }

  // ---- Observation schema used by the CSV upload (names + units + allowed ranges) ----
  // Ranges are physical plausibility limits (errors outside them). They are wider than the
  // scoring bands above; the engine itself clamps values outside its normalisation band.
  var OBS_COLUMNS = [
    { name: "zone_id", engine: null, unit: "", min: null, max: null, desc: "Zone identifier A1 to D6 (row letter A-D, column 1-6)." },
    { name: "date", engine: null, unit: "YYYY-MM-DD", min: null, max: null, desc: "Calendar date the observation applies to." },
    { name: "temp_c", engine: "temp", unit: "degrees C", min: -30, max: 60, desc: "Air temperature in degrees Celsius." },
    { name: "humidity_pct", engine: "hum", unit: "percent", min: 0, max: 100, desc: "Relative humidity, 0 to 100 (a percent, not a fraction)." },
    { name: "wind_kmh", engine: "wind", unit: "km/h", min: 0, max: 200, desc: "Wind speed in kilometres per hour." },
    { name: "ndvi", engine: "ndvi", unit: "index", min: -1, max: 1, desc: "Normalised Difference Vegetation Index. Lower means drier vegetation." },
    { name: "fire_history", engine: "hist", unit: "index 0-1", min: 0, max: 1, desc: "Normalised fire-history index: 0 = no recorded recurrence, 1 = highest recurrence. A 0-1 score, not a count." }
  ];

  var ROW_LETTERS = ["A", "B", "C", "D"];
  var COLS = 6;
  var ZONE_IDS = [];
  ROW_LETTERS.forEach(function (r) { for (var c = 1; c <= COLS; c++) ZONE_IDS.push(r + c); });

  // Score one observation row {temp_c, humidity_pct, wind_kmh, ndvi, fire_history}.
  // Uses the values exactly as given (no demo offsets, no clamping beyond the engine's own).
  function scoreObservation(o) {
    var r = scoreFrom(o.temp_c, o.humidity_pct, o.wind_kmh, o.ndvi, o.fire_history);
    return { score: r.score, contrib: r.contrib, N: r.N };
  }

  return {
    clamp: clamp,
    WEIGHTS: WEIGHTS,
    THRESH_HIGH: THRESH_HIGH,
    THRESH_MED: THRESH_MED,
    STRETCH_OFFSET: STRETCH_OFFSET,
    STRETCH_SPAN: STRETCH_SPAN,
    NORMALISATION: NORMALISATION,
    scoreFrom: scoreFrom,
    scoreObservation: scoreObservation,
    severity: severity,
    OBS_COLUMNS: OBS_COLUMNS,
    ZONE_IDS: ZONE_IDS,
    ENGINE_VERSION: "weighted-v1"
  };
});
