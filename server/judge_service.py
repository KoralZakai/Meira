"""LLM-as-judge: silently evaluates every Lumi response and accumulates improvement guidelines.

Flow: evaluate() is fire-and-forget (asyncio.create_task). Every 10 evals it
synthesizes the notes into lumi_guidelines.txt which lumi_agent.py prepends to
its system prompt — so Lumi self-improves without any manual prompt editing.

Dependencies: config (LLM creds, DATA_DIR). evaluate() is spawned by
main.whatsapp_webhook after every reply; get_guidelines() is read by
lumi_agent.handle_whatsapp_message when building the system prompt.
"""
import json
import logging
from pathlib import Path

from openai import AsyncOpenAI

import config
import secure_store
import model_router
import database_service

logger = logging.getLogger(__name__)

_client: AsyncOpenAI | None = None

LOG = Path(config.DATA_DIR) / "judge_log.json"
GUIDELINES = Path(config.DATA_DIR) / "lumi_guidelines.txt"

JUDGE_PROMPT = """\
You are a strict quality judge for Lumi, a WhatsApp scheduling assistant.

USER MESSAGE: {user_msg}
LUMI RESPONSE: {lumi_response}
EXTRACTED TASK: {task_json}

Evaluate on:
- Did Lumi extract the task correctly? (right category, time, location)
- Was the response short enough? (WhatsApp style, max 2-3 lines)
- Right language? (Hebrew if user wrote Hebrew)
- Did Lumi miss anything important?

Score 1-5. Give ONE concrete improvement note, max 15 words.
Reply with JSON only: {{"score": <int>, "note": "<string>"}}"""


def _client_instance() -> AsyncOpenAI:
    """Lazy singleton OpenAI-compatible client (Nebius endpoint)."""
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_ENDPOINT)
    return _client


async def evaluate(user_msg: str, lumi_response: str, task: dict) -> None:
    """Fire-and-forget judge call. Never raises — judge must never block the main flow."""
    try:
        r = await _client_instance().chat.completions.create(
            model=model_router.pick("judge", prompt_chars=len(user_msg) + len(lumi_response)),
            messages=[{"role": "user", "content": JUDGE_PROMPT.format(
                user_msg=user_msg,
                lumi_response=lumi_response,
                task_json=json.dumps(task, ensure_ascii=False),
            )}],
            response_format={"type": "json_object"},
            max_tokens=80,
            temperature=0.2,
        )
        raw = r.choices[0].message.content or "{}"
        entry = json.loads(raw)
        if "score" in entry:
            _append(entry)
            _maybe_synthesize()
    except Exception as exc:  # noqa: BLE001
        logger.debug("judge skipped: %s", exc)


def _append(entry: dict) -> None:
    """Append one {score, note} eval to judge_log.json, and shadow it into
    Postgres (lumi_judge_log).

    Worth having in a table rather than on a volume: this judge rewrites the
    system prompt every ten replies with no human review, so "when did the
    prompt change, and on the strength of what" is a question somebody will
    eventually need answered.
    """
    # Through secure_store: these notes quote what she actually said, keyed by
    # phone. Raw read_text/write_text left them plaintext and world-readable
    # while the stores around them were encrypted.
    log: list = secure_store.read_json(str(LOG), [])
    log.append(entry)
    secure_store.write_json(str(LOG), log)
    database_service.shadow_write(
        database_service.record_judgement(entry.get("phone"), entry))


def _maybe_synthesize() -> None:
    """Every 10 evals, distill the recent notes into lumi_guidelines.txt."""
    log: list = secure_store.read_json(str(LOG), [])
    if not log or len(log) % 10 != 0:
        return
    recent = log[-10:]
    avg = sum(e.get("score", 3) for e in recent) / len(recent)
    notes = [e["note"] for e in recent if e.get("note")]
    lines = [
        f"JUDGE FEEDBACK (last {len(recent)} evals, avg score {avg:.1f}/5):",
        "Apply these improvements to your responses:",
    ] + [f"- {n}" for n in notes]
    GUIDELINES.write_text("\n".join(lines), encoding="utf-8")
    logger.info("judge: synthesized guidelines (avg %.1f)", avg)


def get_guidelines() -> str:
    """Returns the latest judge guidelines to prepend to the system prompt."""
    return GUIDELINES.read_text(encoding="utf-8") if GUIDELINES.exists() else ""
