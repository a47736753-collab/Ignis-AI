"use strict";
const test = require("node:test");
const assert = require("node:assert");
const M = require("../public/metrics.js");
const REF = require("./fixtures/metrics-reference.json"); // generated with scikit-learn (see docs/TESTING.md)
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + ": " + a + " vs " + b);

for (const c of REF) {
  test("matches scikit-learn: " + c.name, () => {
    close(M.rocCurve(c.labels, c.scores).auc, c.roc_auc, "ROC-AUC");
    const pr = M.prCurve(c.labels, c.scores);
    close(pr.ap, c.ap, "Average Precision");
    close(pr.aucTrapz, c.pr_auc_trapz, "PR-AUC (trapezoid)");
    const cf = M.confusionAt(c.labels, c.scores, c.threshold);
    assert.deepStrictEqual([cf.tp, cf.fp, cf.tn, cf.fn], [c.tp, c.fp, c.tn, c.fn]);
    const r = M.rates(cf);
    close(r.precision, c.precision, "precision"); close(r.recall, c.recall, "recall"); close(r.f1, c.f1, "F1");
  });
}

test("Average Precision and trapezoidal PR-AUC are genuinely different quantities", () => {
  const diff = REF.filter((c) => Math.abs(c.ap - c.pr_auc_trapz) > 1e-6);
  assert.ok(diff.length > 3, "expected AP != trapezoid PR-AUC on most real cases");
  const c = diff[0];
  const pr = M.prCurve(c.labels, c.scores);
  assert.ok(Math.abs(pr.ap - pr.aucTrapz) > 1e-6);
});

test("insufficient data is refused instead of producing numbers", () => {
  const few = M.evaluate([1, 0, 1, 0, 0], [80, 20, 70, 30, 10], 65);
  assert.strictEqual(few.sufficient, false);
  assert.match(few.reason, /at least/);
  const noPos = M.evaluate(new Array(100).fill(0), new Array(100).fill(30), 65);
  assert.strictEqual(noPos.sufficient, false);
  const fewPos = M.evaluate([1, 1].concat(new Array(98).fill(0)), new Array(100).fill(30), 65);
  assert.strictEqual(fewPos.sufficient, false);
  assert.strictEqual(M.evaluate([1], [1, 2], 65).sufficient, false);
});

test("sufficient data returns the full metric set", () => {
  const c = REF[2];
  const e = M.evaluate(c.labels, c.scores, 65);
  assert.strictEqual(e.sufficient, true);
  for (const k of ["rocAuc", "averagePrecision", "prAucTrapezoid", "precision", "recall", "f1", "confusion", "prevalence"]) assert.ok(k in e, k);
  close(e.rocAuc, c.roc_auc, "rocAuc");
});
