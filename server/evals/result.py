"""result — the shape every suite returns, so report.py can treat them alike.

A suite returns ONE dict:

    {"name": "accuracy", "row": "Accuracy",
     "status": "ok" | "not_run" | "error",
     "reason": "<why, when not ok>",
     "metrics": [metric, ...], "details": {...}}

and a metric is:

    {"id": "accuracy.date", "label": "...", "value": 0.97, "unit": "ratio",
     "how": "how it was measured", "failures": [{"input": ..., "expected": ..., "got": ...}],
     "detail": {...}}

`id` is the key into thresholds.json. `failures` are the worked examples the
report prints in its last column: input -> outcome, never just a count.
"""
from __future__ import annotations

import traceback
from typing import Any, Optional

MAX_FAILURES = 8     # per metric; the full list stays in `detail` when it matters


def metric(id: str, label: str, value: Optional[float], unit: str = "ratio", how: str = "",
           failures: Optional[list] = None, detail: Optional[dict] = None) -> dict:
    return {"id": id, "label": label, "value": value, "unit": unit, "how": how,
            "failures": list((failures or [])[:MAX_FAILURES]),
            "failures_total": len(failures or []),
            "detail": detail or {}}


def ok(name: str, row: str, metrics: list, details: Optional[dict] = None) -> dict:
    return {"name": name, "row": row, "status": "ok", "reason": "",
            "metrics": metrics, "details": details or {}}


def not_run(name: str, row: str, reason: str) -> dict:
    """The suite could not run, and says why. NEVER a green."""
    return {"name": name, "row": row, "status": "not_run", "reason": reason,
            "metrics": [], "details": {}}


def errored(name: str, row: str, exc: BaseException) -> dict:
    """The suite crashed. Reported red: a broken harness is a finding."""
    return {"name": name, "row": row, "status": "error",
            "reason": f"{type(exc).__name__}: {str(exc)[:300]}",
            "metrics": [], "details": {"traceback": traceback.format_exc()[-1800:]}}


def clip(value: Any, n: int = 160) -> Any:
    """Shorten a long string for a failure example."""
    if isinstance(value, str) and len(value) > n:
        return value[: n - 1] + "…"
    return value
