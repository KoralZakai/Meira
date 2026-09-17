# Endpoint — serve the distilled parser (vLLM, OpenAI-compatible)

A Nebius Serverless AI **Endpoint** that serves the model
[Job C](../job-eval) picked — normally the LoRA student from
[Job B](../job-finetune) — behind an OpenAI-compatible HTTP API. The Lumi app and
the terminal demo both call it, so the Nebius key never ships inside the app
bundle: pointing the whole app here is a one-line change
(`EXPO_PUBLIC_NEBIUS_BASE_URL` → the endpoint URL).

GPU endpoint — one L4/A100/H100-class device is plenty for a 4B model.

## The contract

`SERVED_MODEL_NAME` (default `lumi-parser`) is the model name clients request. It
must match `STUDENT_MODEL` in Job C and `EXPO_PUBLIC_NEBIUS_MODEL` in the app. The
endpoint exposes the standard vLLM routes: `/v1/chat/completions`, `/v1/models`,
`/health`.

## Two serving recipes (`serve.sh` picks by env)

**A — merged model (simplest).** If Job B ran with `MERGE=1`, point `MODEL_ID` at
the merged repo; no LoRA flags needed:

```
MODEL_ID=Koralzakai/lumi-parser-qwen3-4b-merged
SERVED_MODEL_NAME=lumi-parser
```

**B — base + LoRA adapter.** Keep the base student and load Job B's adapter as a
hot-swappable module named `$SERVED_MODEL_NAME`:

```
MODEL_ID=Qwen/Qwen3-4B-Instruct-2507
LORA_REPO=Koralzakai/lumi-parser-qwen3-4b-lora
SERVED_MODEL_NAME=lumi-parser
```

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `MODEL_ID` | `Qwen/Qwen3-4B-Instruct-2507` | Base or merged model to load |
| `SERVED_MODEL_NAME` | `lumi-parser` | Name clients request (the contract) |
| `LORA_REPO` / `LORA_PATH` | — | HF repo (auto-downloaded) or local path of the adapter |
| `VLLM_API_KEY` | — | If set, the endpoint requires this bearer token |
| `MAX_MODEL_LEN` | `8192` | Context length to serve |
| `GPU_MEMORY_UTILIZATION` | `0.90` | vLLM KV-cache budget |
| `MAX_LORA_RANK` | `16` | Must be ≥ the adapter's `r` (Job B default 16) |
| `DTYPE` | `bfloat16` | Compute dtype |
| `PORT` | `8000` | Container port (pass `--container-port 8000`) |
| `EXTRA_ARGS` | — | Any extra raw `vllm serve` flags |

## Build & deploy

```bash
# Pin VLLM_TAG to a Qwen3-capable release for reproducibility.
docker build --build-arg VLLM_TAG=latest \
  -t docker.io/<dockerhub-user>/lumi-endpoint:latest ./nebius/endpoint
docker push docker.io/<dockerhub-user>/lumi-endpoint:latest

nebius ai endpoint create \
  --name lumi-parser \
  --image docker.io/<dockerhub-user>/lumi-endpoint:latest \
  --container-port 8000 \
  --auth token \
  --env MODEL_ID=Qwen/Qwen3-4B-Instruct-2507 \
  --env LORA_REPO=Koralzakai/lumi-parser-qwen3-4b-lora \
  --env SERVED_MODEL_NAME=lumi-parser \
  --env VLLM_API_KEY=<choose-a-token>
```

## Smoke test

```bash
curl https://<your-endpoint>/v1/chat/completions \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{
    "model": "lumi-parser",
    "messages": [
      {"role":"system","content":"You are Lumi'\''s task parser..."},
      {"role":"user","content":"REFERENCE_DATE: 2026-06-08\nMESSAGE: call mom tomorrow at 5"}
    ],
    "response_format": {"type":"json_object"},
    "temperature": 0
  }'
```

Then point the app/demo at it:

```
EXPO_PUBLIC_NEBIUS_BASE_URL=https://<your-endpoint>/v1
EXPO_PUBLIC_NEBIUS_MODEL=lumi-parser
EXPO_PUBLIC_NEBIUS_API_KEY=<token>
```

## Notes

- The system prompt callers send must be the canonical `PARSER_SYSTEM_PROMPT`
  (see [`../job-datagen/generate.py`](../job-datagen/generate.py)) — the same
  function the student was trained and evaluated on.
- If Job C recommends the **teacher** instead, there is nothing to self-host:
  point the app at AI Studio (`https://api.studio.nebius.ai/v1`,
  `Qwen/Qwen3-235B-A22B-Instruct-2507`). This endpoint exists to serve the
  cheap student.
