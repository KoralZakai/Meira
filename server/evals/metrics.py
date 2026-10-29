"""metrics — the arithmetic behind every number in the evaluation matrix.

Pure and stdlib-only on purpose: a metric that needs numpy to compute is a
metric CI cannot afford, and a metric whose definition is buried in a library
call cannot be argued with. Every definition is written out here, and
tests/test_evals.py pins each one on inputs whose answer is known by hand.

Conventions (the ones people disagree about):

* precision / recall / F1 divide by zero -> 0.0, not NaN and not 1.0. A label
  the system never predicts has precision 0 *by convention*; the report shows
  `support` next to it so a 0 on a one-example label reads as noise.
* macro-F1 averages over every label that appears in the truth OR the
  predictions, unweighted. One rare label that is always wrong costs the same
  as one common label that is always wrong — that is the point of "macro".
* percentile: linear interpolation between the two nearest ranks (the numpy /
  Excel PERCENTILE.INC default). p50 of [1,2,3,4] is 2.5.
* Recall@K is the share of a query's relevant items found in the top K,
  averaged over queries. MRR is the mean of 1/rank of the FIRST relevant hit
  (0 when none is retrieved).
"""
from __future__ import annotations

import math
from typing import Iterable, Optional, Sequence


def accuracy(y_true: Sequence, y_pred: Sequence) -> float:
    """Share of positions where truth == prediction. Empty input -> 0.0."""
    if len(y_true) != len(y_pred):
        raise ValueError(f"length mismatch: {len(y_true)} truths vs {len(y_pred)} predictions")
    if not y_true:
        return 0.0
    return sum(1 for t, p in zip(y_true, y_pred) if t == p) / len(y_true)


def _div(num: float, den: float) -> float:
    return num / den if den else 0.0


def prf(y_true: Sequence, y_pred: Sequence, labels: Optional[Iterable] = None) -> dict:
    """Per-label precision / recall / F1 / support, plus macro and micro averages.

    -> {"labels": {label: {precision, recall, f1, support, tp, fp, fn}},
        "macro": {precision, recall, f1}, "micro": {...}, "accuracy": float}

    `labels` defaults to the union of truth and predictions (sorted by str so
    the output is stable). For single-label classification micro-F1 equals
    accuracy; it is returned anyway so the claim can be checked.
    """
    if len(y_true) != len(y_pred):
        raise ValueError(f"length mismatch: {len(y_true)} truths vs {len(y_pred)} predictions")
    label_list = list(labels) if labels is not None else sorted(
        set(y_true) | set(y_pred), key=str)
    per: dict = {}
    tp_all = fp_all = fn_all = 0
    for label in label_list:
        tp = sum(1 for t, p in zip(y_true, y_pred) if t == label and p == label)
        fp = sum(1 for t, p in zip(y_true, y_pred) if t != label and p == label)
        fn = sum(1 for t, p in zip(y_true, y_pred) if t == label and p != label)
        precision, recall = _div(tp, tp + fp), _div(tp, tp + fn)
        per[label] = {
            "precision": precision, "recall": recall,
            "f1": _div(2 * precision * recall, precision + recall),
            "support": tp + fn, "tp": tp, "fp": fp, "fn": fn,
        }
        tp_all += tp
        fp_all += fp
        fn_all += fn
    n = len(label_list) or 1
    macro = {k: sum(v[k] for v in per.values()) / n for k in ("precision", "recall", "f1")}
    micro_p, micro_r = _div(tp_all, tp_all + fp_all), _div(tp_all, tp_all + fn_all)
    micro = {"precision": micro_p, "recall": micro_r,
             "f1": _div(2 * micro_p * micro_r, micro_p + micro_r)}
    return {"labels": per, "macro": macro, "micro": micro,
            "accuracy": accuracy(y_true, y_pred)}


def set_prf(truth: set, predicted: set) -> dict:
    """Precision / recall / F1 of a PREDICTED SET against a TRUE SET — the
    shape of "which clashes did the day contain"."""
    tp = len(truth & predicted)
    precision, recall = _div(tp, len(predicted)), _div(tp, len(truth))
    return {"precision": precision, "recall": recall,
            "f1": _div(2 * precision * recall, precision + recall),
            "tp": tp, "fp": len(predicted - truth), "fn": len(truth - predicted)}


def percentile(values: Sequence[float], p: float) -> float:
    """p-th percentile (0-100), linear interpolation. Empty input -> NaN, never 0:
    a latency of 0 ms is a claim, not an absence."""
    if not values:
        return float("nan")
    if not 0 <= p <= 100:
        raise ValueError("p must be within 0..100")
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    rank = (p / 100) * (len(ordered) - 1)
    lo, hi = int(math.floor(rank)), int(math.ceil(rank))
    return float(ordered[lo] + (ordered[hi] - ordered[lo]) * (rank - lo))


def latency_summary(values_s: Sequence[float]) -> dict:
    """p50 / p95 / p99 / mean / max in MILLISECONDS from seconds."""
    if not values_s:
        return {"n": 0, "p50_ms": None, "p95_ms": None, "p99_ms": None,
                "mean_ms": None, "max_ms": None}
    ms = [v * 1000 for v in values_s]
    return {"n": len(ms), "p50_ms": percentile(ms, 50), "p95_ms": percentile(ms, 95),
            "p99_ms": percentile(ms, 99), "mean_ms": sum(ms) / len(ms), "max_ms": max(ms)}


def wilson(successes: int, n: int, z: float = 1.96) -> tuple:
    """95% Wilson score interval for a rate. Small samples (n=7) get a wide
    interval, which is the honest way to show "7 of 7" is not "100%"."""
    if n <= 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def recall_at_k(ranked: Sequence, relevant: Iterable, k: int) -> float:
    """|relevant ∩ top-k| / |relevant| for ONE query. No relevant items -> 0.0."""
    rel = set(relevant)
    if not rel:
        return 0.0
    return len(rel & set(list(ranked)[:k])) / len(rel)


def reciprocal_rank(ranked: Sequence, relevant: Iterable) -> float:
    """1 / (1-based rank of the first relevant item), 0.0 when none was retrieved."""
    rel = set(relevant)
    for i, item in enumerate(ranked, start=1):
        if item in rel:
            return 1.0 / i
    return 0.0


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def mrr(rankings: Sequence[Sequence], relevants: Sequence[Iterable]) -> float:
    """Mean reciprocal rank over queries."""
    return mean([reciprocal_rank(r, rel) for r, rel in zip(rankings, relevants)])


def mean_recall_at_k(rankings: Sequence[Sequence], relevants: Sequence[Iterable], k: int) -> float:
    return mean([recall_at_k(r, rel, k) for r, rel in zip(rankings, relevants)])


def rate(count: int, total: int) -> float:
    """count/total, 0.0 for an empty denominator (callers report `total` too)."""
    return count / total if total else 0.0
