# Lumi WhatsApp Backend (FastAPI + Nebius/Qwen)

Personality-aware WhatsApp agent. Inbound messages → Lumi infers a task and
replies warmly, adapting tone to the user's MBTI (quick assessment + behavioral
learning).

> Note: this is a **separate Python service**. It does not run inside Expo. The
> mobile app keeps using AsyncStorage + Supabase; this backend uses PostgreSQL.

## Files
- `main.py` — FastAPI app, `/webhook/whatsapp` (GET verify + POST receive), `/health`
- `lumi_agent.py` — Nebius/Qwen agent with `infer_task_details` tool
- `whatsapp_service.py` — Meta Graph API send / mark-read
- `database_service.py` — asyncpg pool + queries
- `personality_learning_service.py` — behavioral learning (mirrors the RN service)
- `mbti.py` — per-type communication guide for the prompt
- `database/migrations/001_lumi_app_schema.sql` — PostgreSQL schema

## Setup
```bash
cd server
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# No database to create. Tasks live in Supabase; the small server-owned
# records (push token, personality signals) live in $DATA_DIR/user_store.json.

# Configure (reuses the Nebius key from the app's .env if NEBIUS_* unset)
export WHATSAPP_API_TOKEN=...        # from Meta
export WHATSAPP_BUSINESS_PHONE_ID=...
export WHATSAPP_WEBHOOK_VERIFY_TOKEN=any_random_string

uvicorn main:app --reload --port 8000
```

## Webhook
Point your Meta WhatsApp webhook at `https://<host>/webhook/whatsapp` with the
same verify token. The GET handler echoes `hub.challenge` as plain text.

The server runs even without a database — it logs a warning and skips
persistence, so you can smoke-test the LLM reply path first.
