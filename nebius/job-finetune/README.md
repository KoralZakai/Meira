# Job B — LoRA fine-tune (the student)

A Nebius Serverless AI **Job** that LoRA-fine-tunes a small student model
(default `Qwen/Qwen3-4B-Instruct-2507`) on the bilingual dataset from
[Job A](../job-datagen), distilling the teacher's task-parsing into a model cheap
enough to serve a phone app behind a Serverless Endpoint.

GPU job — **1×H100** (`gpu-h100-sxm`, preset `1gpu-16vcpu-200gb`). The 4B base
trains in bf16 with LoRA in well under an 80GB H100; `QLORA=1` is available but not
needed at this size.

The dataset is already in OpenAI chat format (`{"messages":[system,user,assistant]}`)
with the parser system prompt and schema baked in by Job A, so this job declares
nothing about the schema — it just learns the assistant turn. With a modern TRL,
loss is masked to the assistant turn only (`assistant_only_loss`).

## Output (to `OUTPUT_DIR`, default `/output`)

| Path | Contents |
|------|----------|
| `adapter/`     | trained LoRA adapter — what Job C and the endpoint load |
| `merged/`      | base+adapter merged weights (only if `MERGE=1`) |
| `training.json`| final train/eval metrics + the exact config used |

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `STUDENT_MODEL` | `Qwen/Qwen3-4B-Instruct-2507` | Base model to fine-tune |
| `HF_DATASET_REPO` | `Koralzakai/lumi-parser-data` | Dataset repo (Job A output) |
| `DATA_DIR` | — | Local dir with `train.jsonl`/`val.jsonl` (overrides the HF repo) |
| `EPOCHS` | `3` | Training epochs |
| `LEARNING_RATE` | `2e-4` | LoRA learning rate |
| `BATCH_SIZE` / `GRAD_ACCUM` | `8` / `2` | Per-device batch × accumulation (eff. 16) |
| `MAX_LENGTH` | `2048` | Max sequence length |
| `LORA_R` / `LORA_ALPHA` / `LORA_DROPOUT` | `16` / `32` / `0.05` | LoRA hyperparams |
| `LORA_TARGET_MODULES` | all attn+mlp proj | Comma-separated modules to adapt |
| `QLORA` | `0` | `1` to load the base in 4-bit (nf4) |
| `MERGE` | `0` | `1` to also save base+adapter merged weights |
| `SEED` | `7` | Reproducibility |
| `HF_TOKEN` + `HF_MODEL_REPO` | — | If both set, publish the adapter to the Hub |

## Run locally (smoke test on a small GPU box)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# tiny run against a few local examples to validate the pipeline:
DATA_DIR=../job-datagen/data EPOCHS=1 BATCH_SIZE=1 MAX_LENGTH=512 \
  OUTPUT_DIR=./output .venv/bin/python finetune.py
```

## Run as a Nebius Serverless AI Job

```bash
# 1. build & push the public image
docker build -t docker.io/<dockerhub-user>/lumi-finetune:latest .
docker push docker.io/<dockerhub-user>/lumi-finetune:latest

# 2. launch on a single H100 (mount a volume so /output survives teardown)
nebius ai job create \
  --name lumi-finetune \
  --image docker.io/<dockerhub-user>/lumi-finetune:latest \
  --platform gpu-h100-sxm \
  --preset 1gpu-16vcpu-200gb \
  --env HF_DATASET_REPO=Koralzakai/lumi-parser-data \
  --env HF_TOKEN=$HF_TOKEN \
  --env HF_MODEL_REPO=Koralzakai/lumi-parser-qwen3-4b-lora \
  --volume <volume-or-filesystem>:/output \
  --timeout 4h

# 3. watch logs
nebius ai job logs <job-id> --follow
```

## Notes

- The TRL `SFTConfig`/`SFTTrainer` API has drifted across versions
  (`max_seq_length`→`max_length`, `tokenizer`→`processing_class`,
  `assistant_only_loss`). `finetune.py` filters kwargs against the installed
  signature, so it runs across recent TRL releases; if your TRL predates
  `assistant_only_loss` it falls back to full-sequence loss and logs a warning.
- `attn_implementation="sdpa"` avoids a flash-attn build; enable flash-attn
  yourself for extra speed if your image has it.
- Keep `STUDENT_MODEL` consistent with [Job C](../job-eval) and the
  [endpoint](../endpoint) — the adapter only loads onto the base it was trained on.
