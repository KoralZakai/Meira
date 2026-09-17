# Meira — מאירה

A proactive personal assistant for people whose day falls apart in the gap
between *knowing* what is next and *leaving on time for it*.

Meira does not ask you to plan. It reads the day you already have — calendar,
mail, the things you told it in Hebrew over WhatsApp — works out when you must
actually wake up and walk out of the door, and says so before it is too late:

> 🚪 לצאת עכשיו! אוטובוס 251 מארלוזורוב בעוד 12 דקות

Built for the **Nebius × NVIDIA Global AI Hackathon** — *Personal AI* track.

---

## What makes it different

**It plans backwards from arrival, not forwards from now.** An interview at
11:00 in Binyamina is not an 11:00 event. It is a 07:35 alarm, a 08:28 door,
and a specific bus. Meira computes that chain and sets the alarm.

**The cheap decisions are not the model's job.** Sorting a day, resolving
"מחר", labelling a category, picking a check-in intent — all arithmetic and
lookups, all in code, all ~1 ms and free. The model is used for language:
open-ended conversation, tool selection, and deciding which words in a Hebrew
sentence are the tasks.

**Hebrew is first-class, not translated.** The category table, the date parser
and the closure-detection markers are all written Hebrew-first, because an
English-only fallback regex silently finds nothing in the country this runs in.

**It says what it does not know.** Every researched claim cites the source it
came from, and a claim that cannot cite one is dropped rather than softened.

---

## How Nebius and NVIDIA are used

Every model call goes to **Nebius Token Factory**, and the models are
**NVIDIA Nemotron 3**, in three tiers chosen per call by
[`server/model_router.py`](server/model_router.py):

| Tier | Model | Used for |
|---|---|---|
| small | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | task extraction, profile extraction, mail→events, judging |
| medium | `nvidia/nemotron-3-super-120b-a12b` | the conversational agent and tool selection |
| large | `nvidia/Nemotron-3-Ultra-550b-a55b` | long-context research |

Two things move a call off its default tier:

- **Tokens.** A prompt that will not fit a tier's context window escalates,
  because the alternative is a truncated prompt and a confidently wrong answer.
- **Money.** `LLM_MONTHLY_BUDGET_USD` sets a ceiling. Past 80% of it the large
  tier is withdrawn; past 100% everything runs on nano. Meira degrades — it
  never goes dark. A personal assistant that stops answering at month-end is
  worse than one that gets terser.

`GET /diag/models` asks Nebius which models it actually serves and names any
tier pointing at one it does not.

## How Tavily is used

Live search is a **runtime dependency**, not a development convenience
([`server/tavily_search.py`](server/tavily_search.py)):

- **`web_search`** — the agent's window on the world. Tavily first, Google
  Custom Search as the fallback; `recent_days=N` switches to news for "what
  changed since we spoke".
- **`read_page`** — one URL, cleaned full text. A snippet tells you a job
  exists; it does not prepare you for the interview.
- **`place_live_info`** — opening hours, and whether a place still exists.
  Google Places returns a perfectly good address for a clinic that shut last
  year.
- **Meeting briefs** — `POST /app/meeting/brief` researches the next meeting on
  the calendar: who the company is, who the person is, three questions worth
  asking. Every bullet cites a source; uncited bullets are dropped.
- **Agents that watch** — a scheduled personal agent can carry a `watch` query
  it re-runs live, so a "news agent" has actual news.

---

## Architecture

```
WhatsApp webhook ─┐
                  ├─► agent_turn.run_turn ─► lumi_agent.handle_whatsapp_message
POST /agent/chat ─┘         (server/react_loop.py — a hand-written ReAct loop;
                             LangGraph cost 35 MB on a 256 MB machine)
```

- **App** — Expo / React Native / TypeScript, Android. A thin client: it sends
  what the user said and renders what comes back. There is no model call on the
  phone and no model key in the APK.
- **Server** — FastAPI on Fly.io. Holds every credential, runs the ReAct loop
  and its 23 tools.
- **State** — Supabase, plus encrypted JSON on a Fly volume (AES-256-GCM,
  `server/secure_store.py`).

## Privacy — what never reaches the server

Gmail and Google Calendar are read **on the phone**, with the user's own Google
token. The app posts only what it found: a handful of subjects, or one calendar
event. The mailbox and the calendar never leave the device, and no Google
credential exists server-side.

Personal data at rest is encrypted. `DELETE /account` walks every store and
reports, per store, what it deleted — and a structural test fails the build if
a newly added store escapes it.

---

## Running it

```bash
npm install
npm run build:env          # pulls the client env from EAS
npx expo start --clear
```

```bash
cd server
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest tests -q        # 600+ tests, no network
.venv/bin/uvicorn main:app --port 8000
```

Server credentials are environment variables and are never written to disk —
see the `ENV VARIABLES` section of [CLAUDE.md](CLAUDE.md) for the full list.
You will need your own `NEBIUS_API_KEY`, `TAVILY_API_KEY`, Supabase project and
Google Maps key; `google-services.json` is not included — supply your own
Firebase config to build the Android app.

## Notes for readers

- The code says "Lumi" throughout. That was the project's name until it was
  renamed Meira; the rename has not been swept through the source, and doing it
  for appearance's sake would be a large diff across working code.
- Phone numbers and email addresses in tests and docs are placeholders.

## License

MIT — see [LICENSE](LICENSE).
