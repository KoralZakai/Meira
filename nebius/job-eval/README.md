# Job C — evaluate teacher vs student (the gate)

A Nebius Serverless AI **Job** that decides what the
[endpoint](../endpoint) serves. It runs Lumi's parser function on a fair,
held-out **gold set** (`eval_set.jsonl`) against both the teacher and the
student (from [Job B](../job-finetune)), and emits an accuracy / latency / cost
comparison plus a recommendation.

CPU-only — it just calls the inference API / the student's endpoint.

For each model it sends one call per example with the canonical
`PARSER_SYSTEM_PROMPT` (byte-identical to [Job A](../job-datagen)'s and the
endpoint's), parses `{"tasks":[...]}`, and scores it with the same EDD-style
field checks used by `tests/edd-evaluator.ts`, ported to Python and aligned to
the parser schema (`category`, `priority`, `fixedTime`, `deadline`/date-math,
`hasLocation`, `contactName`, recurrence, task count, …).

The gold set is **non-circular**: expectations are hand-authored, not teacher
labels, so the teacher is graded fairly rather than against itself.

## Output (to `OUTPUT_DIR`, default `/output`)

| File | Contents |
|------|----------|
| `report.json` | full metrics per model + per-field breakdown + the decision |
| `report.md`   | human-readable comparison table |

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `NEBIUS_API_KEY` | — | Shared bearer token (`EXPO_PUBLIC_NEBIUS_API_KEY` also accepted) |
| `TEACHER_MODEL` | `Qwen/Qwen3-235B-A22B-Instruct-2507` | Teacher model id |
| `TEACHER_BASE_URL` / `TEACHER_API_KEY` | AI Studio / shared key | Teacher endpoint |
| `STUDENT_MODEL` | `Qwen/Qwen3-4B-Instruct-2507` | Student model id (served name) |
| `STUDENT_BASE_URL` / `STUDENT_API_KEY` | AI Studio / shared key | **Point at the deployed student endpoint** |
| `SKIP_TEACHER` / `SKIP_STUDENT` | `0` | Evaluate only one side |
| `EVAL_SET` | `/app/eval_set.jsonl` | Gold set path |
| `WIN_TOLERANCE` | `0.03` | Student wins if within this of teacher accuracy |
| `TEACHER_PRICE_PER_1M` / `STUDENT_PRICE_PER_1M` | `0` | USD per 1M tokens, for cost column |
| `CONCURRENCY` | `8` | Parallel calls per model |

> The student normally lives behind its own Serverless Endpoint — set
> `STUDENT_BASE_URL`/`STUDENT_API_KEY` to it. With those unset, the job falls
> back to AI Studio + `STUDENT_MODEL`, which evaluates the *base* student (no
> LoRA) — useful as a before/after sanity check.

## Decision rule

The student is recommended for the endpoint when its JSON-validity ≥ 95% **and**
its accuracy is within `WIN_TOLERANCE` of the teacher's — because it is far
cheaper and faster to serve. Otherwise the teacher is kept until the student
improves. The chosen model is what step 4 (deploy the endpoint) should serve.

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
NEBIUS_API_KEY=... OUTPUT_DIR=./output .venv/bin/python evaluate.py
# compare against a deployed student endpoint:
NEBIUS_API_KEY=... \
  STUDENT_BASE_URL=https://<your-endpoint>/v1 STUDENT_API_KEY=<endpoint-token> \
  STUDENT_MODEL=<served-model-name> \
  OUTPUT_DIR=./output .venv/bin/python evaluate.py
```

## Run as a Nebius Serverless AI Job

```bash
docker build -t docker.io/<dockerhub-user>/lumi-eval:latest .
docker push docker.io/<dockerhub-user>/lumi-eval:latest

nebius ai job create \
  --name lumi-eval \
  --image docker.io/<dockerhub-user>/lumi-eval:latest \
  --env NEBIUS_API_KEY=$NEBIUS_API_KEY \
  --env STUDENT_BASE_URL=https://<your-endpoint>/v1 \
  --env STUDENT_API_KEY=<endpoint-token> \
  --env STUDENT_MODEL=<served-model-name> \
  --volume <volume-or-filesystem>:/output \
  --timeout 1h

nebius ai job logs <job-id> --follow
```

## Keeping the prompt in sync

`PARSER_SYSTEM_PROMPT` is duplicated **verbatim** from
`../job-datagen/generate.py`. It is the single source of truth and must stay
byte-identical across Job A (labels), this eval, and the endpoint, or the student
is graded/served against a different function than it was trained on. If you edit
it in one place, edit it in all three.

---

## MODELS mode — compare a list of models, not teacher vs student

Set `MODELS` and this same job becomes a leaderboard instead of a gate. It was
added for the Nemotron switch: the hackathon *requires* an NVIDIA model, but a
rule is a reason to change, not evidence that the change is harmless — and the
model being swapped is the one that reads Hebrew task descriptions.

```
MODELS="qwen=Qwen/Qwen3-235B-A22B-Instruct-2507@0.2,\
nano=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B@0.06,\
super=nvidia/nemotron-3-super-120b-a12b@0.3,\
ultra=nvidia/Nemotron-3-Ultra-550b-a55b@1.0"
```

`label=model_id@price` — the `@price` is USD per 1M tokens and is optional; it
only fills the cost column. Teacher/student mode is untouched when `MODELS` is
unset.

Output is `report.md` (the table) and `report.json` (per-field breakdown and
every individual example). Read `valid JSON` first: below 100% means the model
failed to return parseable output on some calls, and a model that often returns
nothing can still score well on the few answers it did give.

### Running it as a Nebius Serverless Job

This is CPU-only — it just calls the inference API — so it is the cheapest
possible thing to put on Nebius AI Cloud, and it is a genuine use of AI Cloud
compute rather than only Token Factory inference.

```bash
# 1. build and push (any registry the job can pull from)
docker build -t <registry>/lumi-job-eval:latest nebius/job-eval
docker push  <registry>/lumi-job-eval:latest

# 2. submit, with the model list and the key as env
nebius compute job create \
  --name lumi-model-compare \
  --image <registry>/lumi-job-eval:latest \
  --preset cpu-small \
  --env NEBIUS_API_KEY=<key> \
  --env MODELS="qwen=Qwen/Qwen3-235B-A22B-Instruct-2507@0.2,nano=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B@0.06,super=nvidia/nemotron-3-super-120b-a12b@0.3,ultra=nvidia/Nemotron-3-Ultra-550b-a55b@1.0" \
  --mount /output
```

Exact flag names depend on the CLI version — `nebius compute job create --help`
is the authority. The two things that matter are that `NEBIUS_API_KEY` and
`MODELS` reach the container as environment variables, and that `/output` is a
mount that survives the VM, because the report is written there.
