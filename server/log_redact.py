"""log_redact — nothing that finds a person reaches the Fly logs.

7.10 audit: the logs held live coordinates, home and destination addresses,
phone numbers, task text and the Google API key. Fly keeps logs; anyone who
reads them could follow a user. Two layers:
  1. the worst call sites no longer pass the text at all (see the commit);
  2. this filter, on every handler, rewrites what is left:
       key=/token=/signature= query values, Bearer tokens, JWTs → ***
       coordinate pairs → <coords>, phone numbers → ***+last 3, emails → <email>
And httpx/httpcore — which logged EVERY outbound URL at INFO, query string and
all — are set to WARNING.

install() is idempotent; main.py calls it at import and again at startup,
after uvicorn has attached its own handlers.
"""
from __future__ import annotations

import logging
import re

_RULES: list[tuple[re.Pattern, object]] = [
    (re.compile(r"(?i)([?&](?:key|api_key|apikey|token|access_token|refresh_token|signature|code)=)[^&\s\"'<>]+"), r"\1***"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"), r"\1***"),
    (re.compile(r"eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}"), "<jwt>"),
    (re.compile(r"AIza[0-9A-Za-z_-]{30,}"), "<google-key>"),
    (re.compile(r"-?\d{1,3}\.\d{3,}\s*(?:,|%2C)\s*-?\d{1,3}\.\d{3,}", re.I), "<coords>"),
    (re.compile(r"(?i)\b(lat|lng|latitude|longitude)(['\"]?\s*[:=]\s*)-?\d{1,3}\.\d+"), r"\1\2<n>"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "<email>"),
    (re.compile(r"((?:eq|like)\.\*?)\+?\d{6,}"), r"\1***"),
    (re.compile(r"(?<![\w.:/-])\+?(?:\d[\s-]?){6,14}(\d{3})(?![\w.])"), r"***\1"),
]


def redact(text: str) -> str:
    for rx, repl in _RULES:
        text = rx.sub(repl, text)
    return text


class RedactFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if record.name == "uvicorn.access" and isinstance(record.args, tuple):
            # Its formatter UNPACKS args into (client, method, path, version,
            # status); flattening them to None below raised a TypeError on every
            # request of the 8.10 deploy, and the line itself was lost. Its args
            # are plain strings and ints, so redact them where they stand.
            record.args = tuple(redact(a) if isinstance(a, str) else a for a in record.args)
            return True
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001 — a bad format string is not ours to drop
            return True
        clean = redact(msg)
        if clean != msg or record.args:
            record.msg, record.args = clean, None
        if record.exc_text:
            record.exc_text = redact(record.exc_text)
        return True


_FILTER = RedactFilter()
_LOGGERS = ("", "uvicorn", "uvicorn.error", "uvicorn.access")


def install() -> None:
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    for name in _LOGGERS:
        lg = logging.getLogger(name)
        if _FILTER not in lg.filters:
            lg.addFilter(_FILTER)
        for h in lg.handlers:
            if _FILTER not in h.filters:
                h.addFilter(_FILTER)
