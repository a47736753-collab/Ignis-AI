"use strict";
// Runs every Node test file with the built-in test runner (no dependencies). Usage: npm test
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort().map((f) => path.join(__dirname, f));
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
