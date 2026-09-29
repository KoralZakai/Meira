"""secret_guard — a key sent to Meira is caught before anything keeps it.

Koral, 29.9: the "Share setup" text for connecting Claude (which carries a
personal meira_mcp_ key) was shared to Meira's own WhatsApp instead of to
herself. The message was saved to the conversation history and would have
gone to the model with the next turn. Nothing broke; a credential simply
went to the two places it should never be.

So every inbound message (WhatsApp, the app's chat, MCP ask_meira) is checked
FIRST. A match is never stored, never sent to a model, and never logged in
full. A Meira key is REVOKED on the spot, because a key that has been pasted
into a chat is a key that has leaked. She gets one short line saying what
happened and what to do.

Deliberately narrow: a pattern only counts if it is shaped like a real
credential, so "my key is under the mat" is still just a sentence.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

# (label, pattern). Order matters only for which label is reported.
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("meira", re.compile(r"meira_mcp_[A-Za-z0-9_\-]{20,}")),
    ("openai", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}")),
    ("anthropic", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}")),
    ("tavily", re.compile(r"\btvly-[A-Za-z0-9_\-]{20,}")),
    ("google", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("github", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]


def find(text: Optional[str]) -> list[tuple[str, str]]:
    """Every credential-shaped string in `text`, as (label, value)."""
    if not text:
        return []
    out = []
    for label, pat in _PATTERNS:
        for m in pat.finditer(text):
            out.append((label, m.group(0)))
    return out


def redact(text: str) -> str:
    """The text with every credential replaced by [label key removed]."""
    for label, pat in _PATTERNS:
        text = pat.sub(f"[{label} key removed]", text)
    return text


def handle(text: Optional[str], he: bool = True) -> Optional[str]:
    """If `text` carries a credential: revoke what we can, and return the reply
    to send INSTEAD of running the turn. None when the message is clean.

    The caller must not store, log or forward `text` when this returns a reply.
    """
    found = find(text)
    if not found:
        return None
    labels = sorted({label for label, _ in found})
    revoked = 0
    for label, value in found:
        if label == "meira":
            try:
                import mcp_server
                revoked += mcp_server.revoke_token_value(value)
            except Exception as exc:  # noqa: BLE001 — the reply still goes out
                logger.warning("secret_guard: could not revoke a Meira key: %s", type(exc).__name__)
    # Rule 2: say it happened, never what it was.
    logger.warning("secret_guard: blocked a message carrying %s (revoked %d Meira key(s))",
                   ",".join(labels), revoked)
    if "meira" in labels:
        return ("🔐 זה מפתח חיבור של מאירה — לא שמרתי אותו, והוא בוטל עכשיו כי נשלח בצ'אט. "
                "צרי מפתח חדש בתפריט → AI assistants ושלחי אותו לעצמך, לא אליי."
                if he else
                "🔐 That's a Meira connection key — I didn't keep it, and it's now revoked because it was "
                "sent in a chat. Make a new one in Menu → AI assistants and send it to yourself, not to me.")
    return ("🔐 זה נראה כמו מפתח או סיסמה — לא שמרתי את ההודעה ולא העברתי אותה הלאה. "
            "כדאי להחליף את המפתח, ובפעם הבאה לא לשלוח אותו בצ'אט."
            if he else
            "🔐 That looks like a key or password — I didn't keep the message or pass it on. "
            "Rotate that key, and don't send it in a chat next time.")
