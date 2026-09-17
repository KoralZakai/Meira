# Lumi parser endpoint — OpenAI-compatible vLLM server for the distilled student.
# Built on the official vLLM OpenAI image (ships the server + CUDA runtime).
#
# Pin VLLM_TAG to a release that supports Qwen3 (>= 0.8.5). `latest` works but is
# not reproducible — pin a concrete tag/digest for the contest submission.
ARG VLLM_TAG=latest
FROM vllm/vllm-openai:${VLLM_TAG}

# Faster model/adapter pulls from the Hub inside the endpoint container.
# hf_transfer must be installed for HF_HUB_ENABLE_HF_TRANSFER=1, else
# huggingface_hub raises at download time (the base vLLM image may not ship it).
ENV HF_HUB_ENABLE_HF_TRANSFER=1
RUN pip install --no-cache-dir hf_transfer

COPY serve.sh /serve.sh
RUN chmod +x /serve.sh

# Serverless AI Endpoint speaks to this port (pass --container-port 8000).
EXPOSE 8000

# Override the base image's server entrypoint with our env-driven launcher.
ENTRYPOINT ["/serve.sh"]
