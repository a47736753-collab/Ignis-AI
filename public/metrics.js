/*
 * IGNIS AI - evaluation metrics (browser + Node). Pure functions, no dependencies.
 * Verified against scikit-learn (tests/metrics.test.js + tests/fixtures/metrics-reference.json).
 *
 * Definitions (labels: 1 = fire happened in that zone-day, 0 = no fire; scores: 0-100 risk):
 *   ROC-AUC            trapezoidal area under the ROC curve (ties grouped).
 *   Average Precision  step-wise sum  AP = sum_n (R_n - R_{n-1}) * P_n   (NOT a trapezoid; matches sklearn average_precision_score).
 *   PR-AUC (trapezoid) trapezoidal area under the precision-recall curve (matches sklearn auc(recall, precision)).
 *   These two PR numbers are different quantities and are always reported separately.
 *   Precision / recall / F1 / confusion matrix are computed at a stated alert threshold ("alert if score >= threshold").
 *   Precision is defined as 0 when no alerts are raised (no positives predicted).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.IgnisMetrics = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MIN_SAMPLES = 30, MIN_POSITIVES = 5, MIN_NEGATIVES = 5;

  function counts(labels) {
    var p = 0, n = 0;
    for (var i = 0; i < labels.length; i++) { if (labels[i] === 1) p++; else n++; }
    return { n: labels.length, pos: p, neg: n };
  }

  // Are there enough labelled observations for metrics to mean anything?
  function sufficiency(labels, scores) {
    if (!Array.isArray(labels) || !Array.isArray(scores) || labels.length !== scores.length)
      return { ok: false, reason: "labels and scores must be lists of the same length", n: 0, pos: 0, neg: 0 };
    var c = counts(labels);
    var ok = c.n >= MIN_SAMPLES && c.pos >= MIN_POSITIVES && c.neg >= MIN_NEGATIVES;
    var reason = ok ? "" : "needs at least " + MIN_SAMPLES + " labelled zone-days with at least " + MIN_POSITIVES + " fires and " + MIN_NEGATIVES + " non-fires (found " + c.n + " total, " + c.pos + " fires, " + c.neg + " non-fires)";
    return { ok: ok, reason: reason, n: c.n, pos: c.pos, neg: c.neg, min: { samples: MIN_SAMPLES, positives: MIN_POSITIVES, negatives: MIN_NEGATIVES } };
  }

  function confusionAt(labels, scores, th) {
    var tp = 0, fp = 0, tn = 0, fn = 0;
    for (var i = 0; i < labels.length; i++) {
      var pos = scores[i] >= th;
      if (labels[i] === 1) { if (pos) tp++; else fn++; } else { if (pos) fp++; else tn++; }
    }
    return { tp: tp, fp: fp, tn: tn, fn: fn };
  }

  function rates(c) {
    var precision = c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : 0;
    var recall = c.tp + c.fn > 0 ? c.tp / (c.tp + c.fn) : 0;
    var f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    var fpr = c.fp + c.tn > 0 ? c.fp / (c.fp + c.tn) : 0;
    return { precision: precision, recall: recall, f1: f1, falseAlarmRate: fpr };
  }

  // Cumulative true/false positives at every distinct score threshold, highest score first.
  function cumulative(labels, scores) {
    var idx = [], i;
    for (i = 0; i < labels.length; i++) idx.push(i);
    idx.sort(function (a, b) { return scores[b] - scores[a]; });
    var tps = [], fps = [], thr = [], tp = 0, fp = 0;
    for (i = 0; i < idx.length; i++) {
      if (labels[idx[i]] === 1) tp++; else fp++;
      if (i === idx.length - 1 || scores[idx[i + 1]] !== scores[idx[i]]) { tps.push(tp); fps.push(fp); thr.push(scores[idx[i]]); }
    }
    return { tps: tps, fps: fps, thr: thr };
  }

  function trapz(xs, ys) {
    var a = 0;
    for (var i = 1; i < xs.length; i++) a += (xs[i] - xs[i - 1]) * (ys[i] + ys[i - 1]) / 2;
    return a;
  }

  function rocCurve(labels, scores) {
    var c = counts(labels), cu = cumulative(labels, scores);
    var P = Math.max(1, c.pos), N = Math.max(1, c.neg);
    var x = [0], y = [0], i;
    for (i = 0; i < cu.tps.length; i++) { x.push(cu.fps[i] / N); y.push(cu.tps[i] / P); }
    var pts = x.map(function (v, k) { return { x: v, y: y[k] }; });
    return { pts: pts, auc: trapz(x, y) };
  }

  // sklearn semantics: curve stops at the first threshold that reaches full recall.
  function prCurve(labels, scores) {
    var c = counts(labels), cu = cumulative(labels, scores), P = Math.max(1, c.pos);
    var rec = [], prec = [], i, last = cu.tps.length - 1;
    for (i = 0; i < cu.tps.length; i++) { if (cu.tps[i] === c.pos) { last = i; break; } }
    for (i = 0; i <= last; i++) { rec.push(cu.tps[i] / P); prec.push(cu.tps[i] / (cu.tps[i] + cu.fps[i])); }
    // Average precision: step-wise sum over recall increments.
    var ap = 0, prevR = 0;
    for (i = 0; i < rec.length; i++) { ap += (rec[i] - prevR) * prec[i]; prevR = rec[i]; }
    // Trapezoidal PR-AUC over the curve (recall 0 -> precision 1 start point, as in sklearn).
    var xs = [0].concat(rec), ys = [1].concat(prec);
    var pts = xs.map(function (v, k) { return { x: v, y: ys[k] }; });
    return { pts: pts, ap: ap, aucTrapz: trapz(xs, ys), baseline: c.n ? c.pos / c.n : 0 };
  }

  // Everything the Evidence panel needs. Returns { sufficient:false, reason } when data is too thin.
  function evaluate(labels, scores, threshold) {
    var suff = sufficiency(labels, scores);
    if (!suff.ok) return { sufficient: false, reason: suff.reason, n: suff.n, pos: suff.pos, neg: suff.neg };
    var roc = rocCurve(labels, scores), pr = prCurve(labels, scores);
    var conf = confusionAt(labels, scores, threshold), r = rates(conf);
    return { sufficient: true, n: suff.n, pos: suff.pos, neg: suff.neg, threshold: threshold, rocAuc: roc.auc, averagePrecision: pr.ap, prAucTrapezoid: pr.aucTrapz, prevalence: pr.baseline, confusion: conf, precision: r.precision, recall: r.recall, f1: r.f1, falseAlarmRate: r.falseAlarmRate };
  }

  return { MIN_SAMPLES: MIN_SAMPLES, MIN_POSITIVES: MIN_POSITIVES, MIN_NEGATIVES: MIN_NEGATIVES, sufficiency: sufficiency, confusionAt: confusionAt, rates: rates, rocCurve: rocCurve, prCurve: prCurve, evaluate: evaluate };
});
