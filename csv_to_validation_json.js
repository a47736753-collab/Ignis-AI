#!/usr/bin/env node
/*
 * Converts a CSV of risk scores and fire labels into the validation.json file that the
 * IGNIS AI Evidence tab reads. No dependencies. Needs Node 18+.
 *
 * Usage:   node csv_to_validation_json.js input.csv [output.json]
 * Default output: validation.json in the current folder. Copy it into your project's data/ folder
 * and restart the server.
 *
 * Required CSV columns (names are case-insensitive, extra columns are ignored):
 *   risk_score      the IGNIS AI score for that zone-day, a number from 0 to 100
 *   fire_occurred   1 if a fire happened in that zone-day, 0 if not
 *
 * Only use labels that come from an independent record of real fires. Labels you generate yourself
 * make the accuracy numbers meaningless.
 */
const fs = require("fs");
const [, , input, output = "validation.json"] = process.argv;
if (!input) { console.error("Usage: node csv_to_validation_json.js input.csv [output.json]"); process.exit(1); }
let text;
try { text = fs.readFileSync(input, "utf8"); } catch (e) { console.error("Cannot read " + input + ": " + e.message); process.exit(1); }
text = text.replace(/^\uFEFF/, "");
const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
if (lines.length < 2) { console.error("The file needs a header row and at least one data row."); process.exit(1); }
const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
const si = head.indexOf("risk_score"), li = head.indexOf("fire_occurred");
if (si < 0 || li < 0) { console.error("Missing column(s). Required header: risk_score,fire_occurred (found: " + head.join(",") + ")"); process.exit(1); }
const labels = [], scores = [], errors = [];
lines.slice(1).forEach((line, i) => {
  const n = i + 2, c = line.split(",").map((x) => x.trim());
  const s = c[si], l = c[li];
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s || "") ) { errors.push("line " + n + ": risk_score is not a number (" + JSON.stringify(s) + ")"); return; }
  const sv = Number(s);
  if (sv < 0 || sv > 100) { errors.push("line " + n + ": risk_score " + sv + " is outside 0 to 100"); return; }
  if (l !== "0" && l !== "1") { errors.push("line " + n + ": fire_occurred must be exactly 0 or 1 (found " + JSON.stringify(l) + ")"); return; }
  scores.push(sv); labels.push(Number(l));
});
if (errors.length) {
  console.error(errors.length + " problem(s) found. Nothing was written.");
  errors.slice(0, 20).forEach((e) => console.error("  " + e));
  if (errors.length > 20) console.error("  ...and " + (errors.length - 20) + " more");
  process.exit(1);
}
if (scores.length > 100000) { console.error("Too many rows (" + scores.length + "). The website accepts at most 100,000."); process.exit(1); }
fs.writeFileSync(output, JSON.stringify({ labels, scores }));
const fires = labels.filter((x) => x === 1).length, non = labels.length - fires;
console.log("Wrote " + output + ": " + labels.length + " zone-days, " + fires + " fires, " + non + " non-fires.");
if (labels.length < 30 || fires < 5 || non < 5) console.log("WARNING: the website needs at least 30 zone-days with 5 fires and 5 non-fires, so it will withhold the metrics for this file.");
else console.log("Enough labelled data for the Evidence tab to show metrics.");
console.log("Next: copy " + output + " into your project's data folder (it must be named validation.json) and restart the server.");
