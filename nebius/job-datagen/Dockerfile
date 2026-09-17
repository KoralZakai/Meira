# Job A — synthetic data generation for Lumi's task parser.
# Public image; runs on a CPU preset (it only calls the Nebius inference API).
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY generate.py .

# Write the dataset to /output, which the Job mounts as a volume/filesystem so it
# survives after the container VM is torn down.
ENV OUTPUT_DIR=/output
VOLUME ["/output"]

ENTRYPOINT ["python", "generate.py"]
