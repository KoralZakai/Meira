#!/usr/bin/env python3
"""
Job B — LoRA fine-tune of Lumi's distilled task parser (Nebius Serverless AI Job).

Takes the bilingual (Hebrew/English) chat-format dataset produced by Job A and
LoRA-fine-tunes a small student model (default `Qwen/Qwen3-4B-Instruct-2507`) to
imitate the teacher's parsing. The result is a student that collapses Lumi's
multi-step ReAct parse into a single, cheap model call — small enough to serve a
phone app behind a Serverless Endpoint.

Runs on 1×H100 (`gpu-h100-sxm`, `1gpu-16vcpu-200gb`). A 4B model trains in bf16
with LoRA inside ~30GB of an 80GB H100, so QLoRA is optional (QLORA=1).

Input (one of):
  - HF dataset repo (default `Koralzakai/lumi-parser-data`) with train.jsonl/val.jsonl
  - or a local DATA_DIR containing those two files (set DATA_DIR=/data)

Output (to OUTPUT_DIR, default /output):
  adapter/         the trained LoRA adapter (small; this is what Job C/endpoint load)
  merged/          base+adapter merged weights (only if MERGE=1)
  training.json    final loss/eval metrics + the exact config used

The chat format and the parser system prompt are the same ones Job A wrote into
the dataset, so the student learns exactly the function Job C evaluates and the
endpoint serves. Nothing about the schema is re-declared here — it rides in the
data.
"""

import inspect
import json
import os
import sys
from pathlib import Path

# ── Config ─────────────────────────────────────────────────────────────────────

def env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default

def env_bool(name, default=False):
    v = env(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")

def env_float(name, default):
    return float(env(name, str(default)))

def env_int(name, default):
    return int(env(name, str(default)))

STUDENT_MODEL  = env("STUDENT_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
HF_DATASET_REPO = env("HF_DATASET_REPO", "Koralzakai/lumi-parser-data")
DATA_DIR       = env("DATA_DIR")  # local dir with train.jsonl/val.jsonl (overrides HF repo)
OUTPUT_DIR     = Path(env("OUTPUT_DIR", "/output"))

# LoRA
LORA_R         = env_int("LORA_R", 16)
LORA_ALPHA     = env_int("LORA_ALPHA", 32)
LORA_DROPOUT   = env_float("LORA_DROPOUT", 0.05)
LORA_TARGETS   = env("LORA_TARGET_MODULES",
                     "q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj")

# Training
EPOCHS         = env_float("EPOCHS", 3.0)
LR             = env_float("LEARNING_RATE", 2e-4)
BATCH_SIZE     = env_int("BATCH_SIZE", 8)
GRAD_ACCUM     = env_int("GRAD_ACCUM", 2)
MAX_LENGTH     = env_int("MAX_LENGTH", 2048)
WARMUP_RATIO   = env_float("WARMUP_RATIO", 0.03)
LOGGING_STEPS  = env_int("LOGGING_STEPS", 5)
SEED           = env_int("SEED", 7)
QLORA          = env_bool("QLORA", False)
MERGE          = env_bool("MERGE", False)

# Optional publish of the adapter (and merged model) to the Hub
HF_TOKEN       = env("HF_TOKEN")
HF_MODEL_REPO  = env("HF_MODEL_REPO")  # e.g. "Koralzakai/lumi-parser-qwen3-4b-lora"


def log(msg):
    print(f"[finetune] {msg}", flush=True)


# ── Data ───────────────────────────────────────────────────────────────────────

def load_data():
    """Return a DatasetDict with 'train' and (if available) 'validation' splits,
    each row a conversational example: {"messages": [...]}.
    """
    from datasets import load_dataset

    if DATA_DIR:
        d = Path(DATA_DIR)
        files = {"train": str(d / "train.jsonl")}
        if (d / "val.jsonl").exists():
            files["validation"] = str(d / "val.jsonl")
        log(f"loading local dataset from {d}")
        return load_dataset("json", data_files=files)

    log(f"loading dataset from HF repo {HF_DATASET_REPO}")
    return load_dataset(
        HF_DATASET_REPO,
        data_files={"train": "train.jsonl", "validation": "val.jsonl"},
    )


# ── Model ──────────────────────────────────────────────────────────────────────

def load_model_and_tokenizer():
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(STUDENT_MODEL, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    model_kwargs = dict(
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
        attn_implementation="sdpa",  # avoid a flash-attn build dependency
    )

    if QLORA:
        from transformers import BitsAndBytesConfig
        log("QLoRA enabled — loading base in 4-bit (nf4)")
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

    model = AutoModelForCausalLM.from_pretrained(STUDENT_MODEL, **model_kwargs)
    model.config.use_cache = False  # required with gradient checkpointing
    return model, tok


def lora_config():
    from peft import LoraConfig
    return LoraConfig(
        r=LORA_R,
        lora_alpha=LORA_ALPHA,
        lora_dropout=LORA_DROPOUT,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=[m.strip() for m in LORA_TARGETS.split(",") if m.strip()],
    )


# ── Train ──────────────────────────────────────────────────────────────────────

def build_sft_config(has_eval):
    """Build an SFTConfig, including only kwargs the installed TRL version accepts.

    TRL has renamed/added args across versions (max_seq_length->max_length,
    eval_strategy, assistant_only_loss). Filtering by the actual signature keeps
    this robust without pinning a single exact TRL release.
    """
    from trl import SFTConfig

    desired = dict(
        output_dir=str(OUTPUT_DIR / "adapter"),
        num_train_epochs=EPOCHS,
        per_device_train_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=GRAD_ACCUM,
        learning_rate=LR,
        warmup_ratio=WARMUP_RATIO,
        lr_scheduler_type="cosine",
        optim="paged_adamw_8bit" if QLORA else "adamw_torch",
        bf16=True,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        logging_steps=LOGGING_STEPS,
        save_strategy="epoch",
        report_to="none",
        seed=SEED,
        # TRL-version-dependent extras (filtered below if unsupported):
        max_length=MAX_LENGTH,
        max_seq_length=MAX_LENGTH,
        packing=False,
        assistant_only_loss=True,  # mask the prompt; learn only the JSON answer
        eval_strategy="epoch" if has_eval else "no",
    )

    accepted = set(inspect.signature(SFTConfig.__init__).parameters)
    # max_length vs the older max_seq_length — keep whichever this TRL knows.
    if "max_length" in accepted and "max_seq_length" in desired:
        desired.pop("max_seq_length", None)
    elif "max_seq_length" in accepted and "max_length" in desired:
        desired.pop("max_length", None)

    filtered, dropped = {}, []
    for k, v in desired.items():
        if k in accepted:
            filtered[k] = v
        else:
            dropped.append(k)
    if dropped:
        log(f"note: TRL SFTConfig ignored unsupported args: {dropped}")
    if "assistant_only_loss" in dropped:
        log("WARNING: this TRL lacks assistant_only_loss — training on full "
            "sequence (prompt included). Upgrade TRL for completion-only loss.")
    return SFTConfig(**filtered)


def main():
    from trl import SFTTrainer
    from peft import get_peft_model

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    log(f"student={STUDENT_MODEL} qlora={QLORA} epochs={EPOCHS} "
        f"lr={LR} bs={BATCH_SIZE}x{GRAD_ACCUM} r={LORA_R} -> {OUTPUT_DIR}")

    ds = load_data()
    train_ds = ds["train"]
    eval_ds = ds.get("validation")
    log(f"train={len(train_ds)} examples, "
        f"val={len(eval_ds) if eval_ds is not None else 0}")

    model, tok = load_model_and_tokenizer()
    peft_cfg = lora_config()

    if QLORA:
        from peft import prepare_model_for_kbit_training
        model = prepare_model_for_kbit_training(
            model, use_gradient_checkpointing=True)

    cfg = build_sft_config(has_eval=eval_ds is not None)

    # TRL applies the tokenizer's chat template to the "messages" field itself.
    # Pass peft_config when the trainer supports it, else wrap with get_peft_model.
    trainer_params = set(inspect.signature(SFTTrainer.__init__).parameters)
    trainer_kwargs = dict(model=model, args=cfg, train_dataset=train_ds)
    if eval_ds is not None:
        trainer_kwargs["eval_dataset"] = eval_ds
    if "peft_config" in trainer_params:
        trainer_kwargs["peft_config"] = peft_cfg
    else:
        trainer_kwargs["model"] = get_peft_model(model, peft_cfg)
    # Older TRL wants the tokenizer/processing_class passed explicitly.
    if "processing_class" in trainer_params:
        trainer_kwargs["processing_class"] = tok
    elif "tokenizer" in trainer_params:
        trainer_kwargs["tokenizer"] = tok

    trainer = SFTTrainer(**trainer_kwargs)

    log("starting training…")
    train_result = trainer.train()

    adapter_dir = OUTPUT_DIR / "adapter"
    trainer.save_model(str(adapter_dir))
    tok.save_pretrained(str(adapter_dir))
    log(f"saved LoRA adapter -> {adapter_dir}")

    metrics = dict(train_result.metrics)
    if eval_ds is not None:
        metrics.update(trainer.evaluate())

    summary = {
        "student_model": STUDENT_MODEL,
        "dataset": DATA_DIR or HF_DATASET_REPO,
        "train_examples": len(train_ds),
        "val_examples": len(eval_ds) if eval_ds is not None else 0,
        "epochs": EPOCHS,
        "learning_rate": LR,
        "effective_batch_size": BATCH_SIZE * GRAD_ACCUM,
        "lora": {"r": LORA_R, "alpha": LORA_ALPHA, "dropout": LORA_DROPOUT,
                 "targets": LORA_TARGETS},
        "qlora": QLORA,
        "metrics": metrics,
    }
    with open(OUTPUT_DIR / "training.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    log("metrics: " + json.dumps(metrics, ensure_ascii=False))

    if MERGE:
        merge_and_save(adapter_dir)

    maybe_push_to_hf(adapter_dir, summary)
    log("DONE.")


def merge_and_save(adapter_dir):
    """Merge LoRA into the base weights for a standalone servable model."""
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    if QLORA:
        log("MERGE requested but base was 4-bit; reloading base in bf16 to merge.")
    log("merging adapter into base weights…")
    base = AutoModelForCausalLM.from_pretrained(
        STUDENT_MODEL, torch_dtype=torch.bfloat16, trust_remote_code=True)
    merged = PeftModel.from_pretrained(base, str(adapter_dir)).merge_and_unload()
    merged_dir = OUTPUT_DIR / "merged"
    merged.save_pretrained(str(merged_dir), safe_serialization=True)
    AutoTokenizer.from_pretrained(STUDENT_MODEL, trust_remote_code=True
                                  ).save_pretrained(str(merged_dir))
    log(f"saved merged model -> {merged_dir}")


def maybe_push_to_hf(adapter_dir, summary):
    if not HF_TOKEN or not HF_MODEL_REPO:
        log("HF_TOKEN/HF_MODEL_REPO not set — skipping Hub publish.")
        return
    try:
        from huggingface_hub import HfApi
    except ImportError:
        log("huggingface_hub not installed — skipping Hub publish.")
        return

    api = HfApi(token=HF_TOKEN)
    api.create_repo(repo_id=HF_MODEL_REPO, repo_type="model",
                    exist_ok=True, private=False)
    api.upload_folder(folder_path=str(adapter_dir), repo_id=HF_MODEL_REPO,
                      repo_type="model")
    if MERGE and (OUTPUT_DIR / "merged").exists():
        api.upload_folder(folder_path=str(OUTPUT_DIR / "merged"),
                          repo_id=HF_MODEL_REPO, repo_type="model",
                          path_in_repo="merged")
    card = (
        f"# Lumi parser — {STUDENT_MODEL} LoRA\n\n"
        f"LoRA adapter distilling a large teacher's bilingual (Hebrew/English) "
        f"task-parsing into `{STUDENT_MODEL}`, for the Lumi daily planner.\n\n"
        f"- Base: `{STUDENT_MODEL}`\n"
        f"- Data: `{summary['dataset']}` "
        f"({summary['train_examples']} train / {summary['val_examples']} val)\n"
        f"- LoRA: r={LORA_R}, alpha={LORA_ALPHA}, dropout={LORA_DROPOUT}\n"
        f"- Final metrics: `{json.dumps(summary['metrics'], ensure_ascii=False)}`\n\n"
        f"Built for the Nebius Serverless AI Builders Challenge. License: MIT.\n"
    )
    api.upload_file(path_or_fileobj=card.encode("utf-8"), path_in_repo="README.md",
                    repo_id=HF_MODEL_REPO, repo_type="model")
    log(f"published adapter -> https://huggingface.co/{HF_MODEL_REPO}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
