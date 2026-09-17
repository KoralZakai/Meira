# Job A — Synthetic data generation

A Nebius Serverless AI **Job** that builds the training set for Lumi's distilled
task parser. A large teacher model (default `Qwen/Qwen3-235B-A22B-Instruct-2507`)
both **invents** realistic bilingual (Hebrew/English) planner utterances and
**labels** them into Lumi's `ParsedTask[]` schema. The label is exactly the
function the student is trained to imitate (see `../job-finetune`).

CPU-only — it just calls the Nebius inference API, no GPU needed.

## Output (to `OUTPUT_DIR`, default `/output` in the container)

| File | Contents |
|------|----------|
| `raw.jsonl`   | full record per example: scenario, utterance, reference_date, parsed tasks |
| `train.jsonl` | chat-format fine-tuning examples (system / user / assistant) |
| `val.jsonl`   | held-out split, same format |
| `stats.json`  | counts by language / category / complexity, reject count |

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `NEBIUS_API_KEY` | — (required) | Bearer token (`EXPO_PUBLIC_NEBIUS_API_KEY` also accepted) |
| `NEBIUS_BASE_URL` | `https://api.studio.nebius.ai/v1` | Inference endpoint |
| `TEACHER_MODEL` | `Qwen/Qwen3-235B-A22B-Instruct-2507` | Teacher used for both stages |
| `N_EXAMPLES` | `40` | Target number of examples |
| `VAL_FRACTION` | `0.1` | Held-out fraction |
| `CONCURRENCY` | `8` | Parallel teacher calls |
| `SEED` | `7` | Deterministic scenarios + split |
| `OUTPUT_DIR` | `./data` (local) / `/output` (Docker) | Where files are written |

Generation is deterministic for a fixed `SEED` + `N_EXAMPLES`, so a run is
reproducible.

## Run locally (validate before spending Job compute)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
NEBIUS_API_KEY=... N_EXAMPLES=10 .venv/bin/python generate.py
```

## Run as a Nebius Serverless AI Job

```bash
# 1. build & push the public image
docker build -t docker.io/<dockerhub-user>/lumi-datagen:latest .
docker push docker.io/<dockerhub-user>/lumi-datagen:latest

# 2. launch the job (CPU preset; mount a volume so /output survives teardown)
nebius ai job create \
  --name lumi-datagen \
  --image docker.io/<dockerhub-user>/lumi-datagen:latest \
  --env NEBIUS_API_KEY=$NEBIUS_API_KEY \
  --env N_EXAMPLES=1500 \
  --platform <cpu-platform> \
  --preset <cpu-preset> \
  --volume <volume-or-filesystem>:/output \
  --timeout 3h

# 3. watch logs
nebius ai job logs <job-id> --follow
```

The dataset can then be published (e.g. to a Hugging Face dataset repo) for full
reproducibility — see the top-level README.

## Notes / known teacher noise

- Labels are teacher-generated, so a small fraction carry minor date-math slips or
  imperfect category choices. Invalid JSON, wrong enums, and duplicated-task labels
  (e.g. an expanded recurrence) are rejected automatically (`stats.json.rejected`).
- The parser system prompt in `generate.py` is the single source of truth and must
  stay identical in the eval job and the endpoint, or the student is graded/served
  against a different function than it was trained on.
