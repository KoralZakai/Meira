"""Home and privacy URLs on the server — now pointers to Meira's website.

Google's OAuth consent screen was given lumi-whatsapp.fly.dev/ and /privacy
(30.9) because it needs both before it leaves "Testing". The real pages now
live at https://meirasecretary.github.io (site/ in this repo). Serving a second,
shorter privacy policy here would mean two policies that drift apart, so these
routes only redirect. The links already registered with Google keep working.
"""
from fastapi import APIRouter
from fastapi.responses import RedirectResponse

router = APIRouter()

SITE = "https://meirasecretary.github.io"


@router.get("/", include_in_schema=False)
async def home() -> RedirectResponse:
    return RedirectResponse(SITE + "/", status_code=302)


@router.get("/privacy", include_in_schema=False)
async def privacy() -> RedirectResponse:
    return RedirectResponse(SITE + "/privacy.html", status_code=302)


@router.get("/delete-account", include_in_schema=False)
async def delete_account_page() -> RedirectResponse:
    return RedirectResponse(SITE + "/delete-account.html", status_code=302)


# ─── /g/{token}: answer a "find time together" invite without the app ─────────
# Feature 3 (20.10). Someone not on Meira gets this link from the organizer's
# own WhatsApp/SMS. One page, no JS, no account: tick yes/no per slot, send.
# The token is the only key (stored hashed, expires in 14 days).

import html as _html

from fastapi import Request
from fastapi.responses import HTMLResponse

import group_time

_DAYS_HE = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]


def _page(body: str) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><html lang='he' dir='rtl'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>Meira · מוצאים זמן</title><style>"
        "body{font-family:system-ui,sans-serif;background:#FFFDF5;color:#2D2D2D;margin:0;padding:16px;max-width:480px}"
        "h1{font-size:20px;margin:8px 0}p{color:#645843;font-size:14px}"
        ".s{display:flex;justify-content:space-between;align-items:center;background:#FFF8E7;border-radius:12px;padding:12px;margin:8px 0}"
        "label{margin-inline-start:12px;font-size:15px;min-height:44px;display:inline-flex;align-items:center;gap:4px}"
        "button{width:100%;min-height:48px;background:#FFD166;border:0;border-radius:12px;font-size:16px;margin-top:12px}"
        "</style></head><body>" + body + "</body></html>")


def _when(slot: dict) -> str:
    from datetime import date as _d
    d = _d.fromisoformat(str(slot["day"]))
    return f"יום {_DAYS_HE[d.weekday()]} {d.day}.{d.month} · {slot['start']}"


@router.get("/g/{token}", include_in_schema=False)
async def group_invite(token: str) -> HTMLResponse:
    g, m, slots, reason = await group_time.by_token(token)
    if g is None or slots is None:
        msg = {"expired": "הקישור פג תוקף. בקשי מהמארגנת קישור חדש.",
               "read_failed": "לא הצלחתי לטעון את ההזמנה כרגע. נסי שוב בעוד רגע."}.get(
            reason, "ההזמנה לא נמצאה.")
        return _page(f"<h1>Meira</h1><p>{msg}</p>")
    if (g.get("status") or "open") != "open":
        return _page("<h1>Meira</h1><p>ההזמנה הזו כבר נסגרה — המועד נקבע.</p>")
    title = _html.escape(g.get("title") or "מפגש")
    rows = "".join(
        f"<div class='s'><span>{_html.escape(_when(s))}</span><span>"
        f"<label><input type='radio' name='{s['id']}' value='yes'>כן</label>"
        f"<label><input type='radio' name='{s['id']}' value='no'>לא</label></span></div>"
        for s in slots)
    return _page(f"<h1>👥 {title}</h1><p>באילו מועדים את/ה פנוי/ה? ({g['minutes']} דק׳)</p>"
                 f"<form method='post'>{rows}<button type='submit'>לשלוח</button></form>"
                 "<p style='font-size:12px'>נשלח רק כן/לא — שום דבר אחר.</p>")


@router.post("/g/{token}", include_in_schema=False)
async def group_invite_answer(token: str, request: Request) -> HTMLResponse:
    form = await request.form()
    answers = {str(k): str(v) for k, v in form.items() if str(v) in ("yes", "no")}
    if not answers:
        return _page("<h1>Meira</h1><p>לא סומן אף מועד. חזרי אחורה וסמני כן/לא.</p>")
    res = await group_time.answer_by_token(token, answers)
    if not res.get("ok"):
        msg = {"closed": "ההזמנה כבר נסגרה.", "expired": "הקישור פג תוקף."}.get(
            res.get("reason"), "לא נשמר — נסי שוב בעוד רגע.")
        return _page(f"<h1>Meira</h1><p>{msg}</p>")
    return _page("<h1>✓ נשלח</h1><p>תודה! המארגנת תראה את התשובות שלך.</p>")
