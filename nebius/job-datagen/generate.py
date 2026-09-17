#!/usr/bin/env python3
"""
Job A — Synthetic data generation for Lumi's task parser (Nebius Serverless AI Job).

Two-stage distillation data pipeline, both stages driven by a large teacher model
served on Nebius:

  Stage 1 (user simulator): produce a realistic, spoken-style utterance a busy
           person might say to a voice planner, parameterized by a sampled scenario
           (category, language, multi-task, whether it mentions a time/deadline/
           location/contact/recurrence). This forces diversity.

  Stage 2 (parser / teacher): label that utterance into Lumi's ParsedTask[] schema.
           This output is EXACTLY the function the student model will learn — so the
           student is distilled to imitate the teacher's parsing, collapsing Lumi's
           multi-step ReAct loop into a single model call.

Output (written to OUTPUT_DIR, default ./data):
  raw.jsonl    one record per example: {scenario, utterance, reference_date, tasks}
  train.jsonl  chat-format fine-tuning examples (system/user/assistant)
  val.jsonl    held-out split, same format
  stats.json   counts by language / category / complexity, plus reject counts

The chat format matches what Job B (fine-tune) and the Serverless Endpoint expect:
  {"messages": [{"role": "system", ...},
                {"role": "user", ...},
                {"role": "assistant", "<ParsedTask[] JSON>"}]}

Everything is configured via environment variables (see README). The script runs
locally for a small N to validate, then unchanged inside the Job container at scale.
"""

import json
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

from openai import OpenAI

# ── Lumi schema (mirrors src/types/index.ts — keep in sync) ──────────────────

CATEGORIES = [
    "interview", "course", "conference", "class", "work", "meeting", "call",
    "doctor", "gym", "aspiration", "leisure", "general", "zoom", "hobby_class",
]
PRIORITIES = ["must", "have_to", "need_to", "nice_to_do"]
RECURRENCE_TYPES = ["daily", "weekly", "monthly"]

# The canonical parser function the student learns. MUST stay identical across
# Job A (labels), Job C (eval) and the Endpoint, or the student is graded/served
# against a different function than it was trained on.
PARSER_SYSTEM_PROMPT = f"""You are Lumi's task parser. Convert a user's natural-language message (English, Hebrew, or a mix) into structured tasks.

Respond with ONLY a JSON object, no prose: {{"tasks": [ ... ]}}

Each task object may contain:
- "text" (string, required): concise task description, in the user's language.
- "category" (string, required): one of {CATEGORIES}.
- "priority" (string, required): one of {PRIORITIES}. Infer from urgency; default "need_to".
- "fixedTime" (string "HH:MM", optional): only if the user states a specific clock time.
- "deadline" (string "YYYY-MM-DD", optional): resolve relative dates ("tomorrow", "next Monday", "in 3 days") against REFERENCE_DATE.
- "hasDeadline" (bool): true iff a day/deadline was specified.
- "location" (string, optional) and "hasLocation" (bool).
- "contactName" (string, optional), "contactPhone" (string, optional).
- "how" (string, optional): method, if the user explains it.
- "why" (string, optional): reason, if the user explains it.
- "subgroup" (string, optional): a shared project label when several tasks belong together.
- "isRecurring" (bool, optional), "recurrenceType" ("daily"|"weekly"|"monthly", optional), "recurrenceDays" (int, optional).
- "tags" (string array, required): a few lowercase keywords.

Rules:
- Split multiple INDEPENDENT tasks into separate objects.
- A repeating task is ONE object with "isRecurring": true and recurrence fields.
  Never expand it into one object per occurrence, and never duplicate the same task.
- Do not emit two task objects with identical "text".
- Keep "text" faithful to the user; never invent details that were not said.
- Resolve every date relative to REFERENCE_DATE.
- Output valid JSON only."""

# ── Config ───────────────────────────────────────────────────────────────────

def env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default

API_KEY      = env("NEBIUS_API_KEY") or env("EXPO_PUBLIC_NEBIUS_API_KEY")
BASE_URL     = env("NEBIUS_BASE_URL", "https://api.studio.nebius.ai/v1")
TEACHER      = env("TEACHER_MODEL", "Qwen/Qwen3-235B-A22B-Instruct-2507")
N_EXAMPLES   = int(env("N_EXAMPLES", "40"))
VAL_FRACTION = float(env("VAL_FRACTION", "0.1"))
CONCURRENCY  = int(env("CONCURRENCY", "8"))
SEED         = int(env("SEED", "7"))
OUTPUT_DIR   = Path(env("OUTPUT_DIR", "./data"))
MAX_RETRIES  = int(env("MAX_RETRIES", "4"))

# Anchor reference dates chosen to cover different weekdays so the model learns
# "next Monday"/"in 3 days" style resolution rather than memorizing one date.
REFERENCE_DATES = [
    "2026-06-07",  # Sunday
    "2026-06-10",  # Wednesday
    "2026-06-12",  # Friday
    "2026-09-01",  # Tuesday
    "2026-11-19",  # Thursday
]

LANGUAGES = ["English", "Hebrew", "mixed Hebrew and English"]
COMPLEXITY = ["single", "single", "multi", "multi", "multi"]  # weighted toward multi
ATTRIBUTES = ["fixed_time", "deadline", "location", "contact", "recurring", "how_why"]

# ── Teacher calls ────────────────────────────────────────────────────────────

def make_client():
    if not API_KEY:
        sys.exit("ERROR: set NEBIUS_API_KEY (or EXPO_PUBLIC_NEBIUS_API_KEY).")
    return OpenAI(api_key=API_KEY, base_url=BASE_URL)

def with_retries(fn):
    last = None
    for attempt in range(MAX_RETRIES):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — batch job, log & back off
            last = e
            time.sleep(min(2 ** attempt, 10))
    raise last

def sample_scenario(rng):
    n_attrs = rng.choice([0, 1, 1, 2, 2, 3])
    return {
        "language": rng.choice(LANGUAGES),
        "complexity": rng.choice(COMPLEXITY),
        "primary_category": rng.choice(CATEGORIES),
        "attributes": sorted(rng.sample(ATTRIBUTES, k=min(n_attrs, len(ATTRIBUTES)))),
        "reference_date": rng.choice(REFERENCE_DATES),
    }

def gen_utterance(client, scenario):
    n = "one task" if scenario["complexity"] == "single" else "2 to 4 separate tasks"
    attrs = scenario["attributes"]
    attr_hint = (
        "Naturally include: " + ", ".join(a.replace("_", " ") for a in attrs) + "."
        if attrs else "Keep it simple; do not force extra details."
    )
    prompt = (
        f"You are simulating a busy person speaking to a voice daily-planner app.\n"
        f"Produce ONE realistic spoken message in {scenario['language']}.\n"
        f"It should contain {n}, themed around: {scenario['primary_category']}.\n"
        f"{attr_hint}\n"
        f"Make it sound spoken and natural (mild fillers ok), not a polished sentence.\n"
        f"Output ONLY the message text, no quotes, no explanation."
    )
    def call():
        r = client.chat.completions.create(
            model=TEACHER,
            messages=[{"role": "user", "content": prompt}],
            temperature=1.0, max_tokens=160,
        )
        return r.choices[0].message.content.strip().strip('"')
    return with_retries(call)

def label_utterance(client, utterance, reference_date):
    user_turn = f"REFERENCE_DATE: {reference_date}\nMESSAGE: {utterance}"
    def call():
        r = client.chat.completions.create(
            model=TEACHER,
            messages=[
                {"role": "system", "content": PARSER_SYSTEM_PROMPT},
                {"role": "user", "content": user_turn},
            ],
            temperature=0.2, max_tokens=900,
            response_format={"type": "json_object"},
        )
        return r.choices[0].message.content.strip()
    return with_retries(call), user_turn

# ── Validation ───────────────────────────────────────────────────────────────

def valid_tasks(payload):
    """Parse + sanity-check the teacher's label. Returns tasks list or None."""
    try:
        obj = json.loads(payload)
    except json.JSONDecodeError:
        return None
    tasks = obj.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return None
    texts = [t.get("text") for t in tasks if isinstance(t, dict)]
    if len(texts) != len(set(texts)):
        return None  # reject duplicated-task labels (e.g. expanded recurrences)
    for t in tasks:
        if not isinstance(t, dict) or not t.get("text"):
            return None
        if t.get("category") not in CATEGORIES:
            return None
        if t.get("priority") not in PRIORITIES:
            return None
        if not isinstance(t.get("tags", []), list):
            return None
        rt = t.get("recurrenceType")
        if rt is not None and rt not in RECURRENCE_TYPES:
            return None
    return tasks

# ── Pipeline ─────────────────────────────────────────────────────────────────

def build_example(client, idx):
    rng = random.Random(SEED * 100003 + idx)  # deterministic per-index
    scenario = sample_scenario(rng)
    utterance = gen_utterance(client, scenario)
    if not utterance:
        return None
    raw_label, user_turn = label_utterance(client, utterance, scenario["reference_date"])
    tasks = valid_tasks(raw_label)
    if tasks is None:
        return {"_rejected": True, "scenario": scenario, "utterance": utterance}
    canonical = json.dumps({"tasks": tasks}, ensure_ascii=False)
    return {
        "scenario": scenario,
        "reference_date": scenario["reference_date"],
        "utterance": utterance,
        "user_turn": user_turn,
        "tasks": tasks,
        "chat": {
            "messages": [
                {"role": "system", "content": PARSER_SYSTEM_PROMPT},
                {"role": "user", "content": user_turn},
                {"role": "assistant", "content": canonical},
            ]
        },
    }

def main():
    client = make_client()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[datagen] teacher={TEACHER} base={BASE_URL} n={N_EXAMPLES} "
          f"concurrency={CONCURRENCY} -> {OUTPUT_DIR}", flush=True)

    results, rejects = [], []
    seen_utterances = set()
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(build_example, client, i): i for i in range(N_EXAMPLES)}
        done = 0
        for fut in as_completed(futures):
            done += 1
            ex = fut.result()
            if ex is None:
                continue
            if ex.get("_rejected"):
                rejects.append(ex)
            elif ex["utterance"] in seen_utterances:
                pass  # dedup identical utterances
            else:
                seen_utterances.add(ex["utterance"])
                results.append(ex)
            if done % 10 == 0 or done == N_EXAMPLES:
                print(f"[datagen] {done}/{N_EXAMPLES} processed "
                      f"({len(results)} kept, {len(rejects)} rejected)", flush=True)

    if not results:
        sys.exit("ERROR: no valid examples generated; check API key / model id.")

    # Deterministic train/val split.
    random.Random(SEED).shuffle(results)
    n_val = max(1, int(len(results) * VAL_FRACTION))
    val, train = results[:n_val], results[n_val:]

    def dump(name, rows, key):
        with open(OUTPUT_DIR / name, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r[key] if key else r, ensure_ascii=False) + "\n")

    dump("raw.jsonl", results, None)
    dump("train.jsonl", train, "chat")
    dump("val.jsonl", val, "chat")

    stats = {
        "requested": N_EXAMPLES,
        "kept": len(results),
        "rejected": len(rejects),
        "train": len(train),
        "val": len(val),
        "teacher": TEACHER,
        "by_language": _count(results, lambda e: e["scenario"]["language"]),
        "by_complexity": _count(results, lambda e: e["scenario"]["complexity"]),
        "by_primary_category": _count(results, lambda e: e["scenario"]["primary_category"]),
        "avg_tasks_per_example": round(
            sum(len(e["tasks"]) for e in results) / len(results), 2),
    }
    with open(OUTPUT_DIR / "stats.json", "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    print(f"[datagen] DONE: {len(train)} train + {len(val)} val "
          f"({len(rejects)} rejected). Stats -> {OUTPUT_DIR/'stats.json'}", flush=True)
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)

    maybe_push_to_hf(stats)

def maybe_push_to_hf(stats):
    """Publish the dataset to a Hugging Face dataset repo if HF_TOKEN is set."""
    token = env("HF_TOKEN")
    repo = env("HF_DATASET_REPO")
    if not token or not repo:
        print("[datagen] HF_TOKEN/HF_DATASET_REPO not set — skipping HF publish.", flush=True)
        return
    try:
        from huggingface_hub import HfApi
    except ImportError:
        print("[datagen] huggingface_hub not installed — skipping HF publish.", flush=True)
        return

    api = HfApi(token=token)
    api.create_repo(repo_id=repo, repo_type="dataset", exist_ok=True, private=False)
    for name in ("train.jsonl", "val.jsonl", "raw.jsonl", "stats.json"):
        path = OUTPUT_DIR / name
        if path.exists():
            api.upload_file(path_or_fileobj=str(path), path_in_repo=name,
                            repo_id=repo, repo_type="dataset")
    card = (
        f"# Lumi parser distillation data\n\n"
        f"Synthetic bilingual (Hebrew/English) task-parsing data for fine-tuning a "
        f"small student model, generated by `{stats['teacher']}` on Nebius.\n\n"
        f"- Examples: {stats['kept']} ({stats['train']} train / {stats['val']} val)\n"
        f"- Avg tasks/example: {stats['avg_tasks_per_example']}\n"
        f"- Format: OpenAI chat messages (system/user/assistant) in `train.jsonl`/`val.jsonl`\n\n"
        f"Built for the Nebius Serverless AI Builders Challenge. License: MIT.\n"
    )
    api.upload_file(path_or_fileobj=card.encode("utf-8"), path_in_repo="README.md",
                    repo_id=repo, repo_type="dataset")
    print(f"[datagen] published to https://huggingface.co/datasets/{repo}", flush=True)

def _count(rows, keyfn):
    out = {}
    for r in rows:
        k = keyfn(r)
        out[k] = out.get(k, 0) + 1
    return out

if __name__ == "__main__":
    main()
