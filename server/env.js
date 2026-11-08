"use strict";
// Tiny .env loader so the project needs no dependencies.
const fs = require("fs");
const path = require("path");

function load(file) {
  const p = file || path.join(__dirname, "..", ".env");
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch (e) { return; }
  text.split(/\r?\n/).forEach((line) => {
    if (line.trim().startsWith("#")) return;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) return;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}
module.exports = { load };
