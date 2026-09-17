# Job C — evaluate teacher vs student on Lumi's parser.
# Public image; runs on a CPU preset (it only calls inference APIs/endpoints).
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY evaluate.py .
COPY eval_set.jsonl .

# Reports are written to /output, mounted as a volume/filesystem so they survive
# after the Job's VM is torn down.
ENV OUTPUT_DIR=/output \
    EVAL_SET=/app/eval_set.jsonl
VOLUME ["/output"]

ENTRYPOINT ["python", "evaluate.py"]
