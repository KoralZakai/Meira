# Job B — LoRA fine-tune of Lumi's distilled task parser.
# Public image; runs on a single H100 (gpu-h100-sxm, 1gpu-16vcpu-200gb).
# torch + CUDA ship in the base image so the build stays small and reproducible.
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-devel

WORKDIR /app

# Quieter, more cache-friendly HF behavior inside the Job container.
ENV HF_HUB_ENABLE_HF_TRANSFER=1 \
    PYTHONUNBUFFERED=1 \
    TOKENIZERS_PARALLELISM=false

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt hf_transfer

COPY finetune.py .

# Adapter + metrics are written to /output, mounted as a volume/filesystem so
# they survive after the Job's VM is torn down.
ENV OUTPUT_DIR=/output
VOLUME ["/output"]

ENTRYPOINT ["python", "finetune.py"]
