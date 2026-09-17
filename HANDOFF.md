# Lumi — handoff

`master` @ latest, pushed, Fly + Vercel deployed. Read `CLAUDE.md` first.
Memory: `~/.claude/projects/-Users-user-dev-Lumi-My-AI-Assistant/memory/`.

## The sync WORKS. Read `keyRole` before believing any number.

```bash
curl -s "https://lumi-whatsapp.fly.dev/diag/sync?phone=972500000000" | python3 -m json.tool
```
Expect `keyRole: service_role`, `phone.linked: true`, `taskRowCount` ~95.

It was **two** silent bugs, not one, and both produced the identical symptom:

1. **The app could not sign in.** Local builds shipped with no `EXPO_PUBLIC_*`
   — they are inlined at build time and there is no committed `.env`. Fixed:
   `npm run build:env` now refuses to build without them. Note `eas env:pull`
   alone is NOT enough: it writes `.env.local`, and `.easignore` ships only
   `.env.production`.
2. **The server could not SEE.** `SUPABASE_SERVICE_ROLE_KEY` on Fly held the
   **anon** key, which is subject to RLS — so every query returned `200 OK`
   with an empty array, forever.

**`200 OK` with zero rows is not evidence of emptiness.** Three sessions read a
blind probe as fact. `/diag/sync` now reports `projectRef` and `keyRole`.

## Working and verified on the phone

Zoom links no longer get a bus route or a wake alarm · clashes are detected
(including back-to-back in two places) and offer real choices · travel origin
chains place-to-place instead of always starting from home · alerts name where
you're going and by when · Done/Reschedule/Delete on tasks whose time has
passed · Upcoming sorted · search by text and by topic · home address in
Profile · the join link and attendees on task detail.

`npm run test:all` → 17 suites, all green. `npx tsc --noEmit` → **36 errors is
the baseline**, do not chase it. Python: `cd server && python3 -m pytest tests/ -q`
→ 158.

## Open — in priority order

1. **The WhatsApp agent saves badly.** See `lumi-whatsapp-agent-not-saving` in
   memory. It replies and creates *some* tasks, but "gym and party this
   evening" produced only the party, and **every task arrives with no time**
   (`--:--` server-side), which also keeps them off the Today timeline. Start
   at `server/lumi_agent.py`; needs `ADMIN_TOKEN` or `fly ssh` to read a real
   conversation — ask Koral.
2. **STT through the server.** Settled by evidence: WhatsApp voice notes
   transcribe well in Hebrew and English via Groq `whisper-large-v3`
   (`server/stt.py`). Add `POST /stt` + an audio recorder in the app. Do NOT
   ship an on-device model — every Hebrew Whisper is ≥1.5GB against a 90MB APK.
3. **Lumi should speak** — short, warm. `expo-speech` is already used for the
   morning briefing.
4. **Dynamic origin from real GPS.** The chain now re-plans when the *schedule*
   implies a different start. Koral wants it to follow where she actually is.
   `utils/positionDrift.ts` is written and tested and has **zero consumers**.
5. **Phase 3** (needs its own session): known-places store, real learning,
   location clustering, an undated backlog, and a real `optimize_day` — the
   current one at `LLMService.ts:644` only SORTS.

Also: Firebase/FCM unconfigured so server push has never worked (local alarms
unaffected; Koral deferred it deliberately — adding Firebase to the GCP project
is irreversible). Two bug reports filed from WhatsApp are unread.

**Unresolved:** cloud task count fell 154 → 113 → 92 across syncs. Not
explained. `syncAllTasks` now deletes only rows that positively identify as
app-created, which stops that shape of loss but recovers nothing.

## Working in this repo

The bug-agent daemon runs on a timer and used to `git checkout master` in the
live directory, which two handoffs blamed on EAS builds. It now works in a git
worktree under `~/dev/.lumi-bug-worktrees/` — verified in production, three
bugs processed while the main checkout stayed on master.

**Another session may be editing this tree concurrently.** Check `git status`
before committing and stage only your own files.

## How she works

Hebrew, short, concrete. ADHD — bullets, no walls of text. Wants root causes and
evidence, not reassurance. Proving a premise wrong with a command is welcome;
several were wrong across these sessions and saying so plainly was the useful
move.
