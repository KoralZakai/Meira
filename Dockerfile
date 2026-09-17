# Fly.io deploys the Python FastAPI backend that lives in server/.
# (The mobile app is NOT deployed here — it ships as an Android build via EAS.)
# Build context is the repo root (where fly.toml lives), so we copy from server/.
FROM python:3.11-slim
WORKDIR /app
# No system packages: the Pango/Cairo/font layer here existed only for
# WeasyPrint, which rendered the tailored-CV PDF for the job scout. Both are
# gone (2026-09-07), and so is ~120MB of image and the RAM their shared
# libraries occupied in a 256MB machine that was already OOM-prone.
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ .
EXPOSE 8000
# The live lumi-whatsapp app routes to internal_port 8000 (its previous working
# image bound 8000). Bind there by default; Fly can still inject PORT to override.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
