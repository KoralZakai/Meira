# Security hardening — routes, secrets, encryption at rest

**Scope:** `server/` route authorization, client secret exposure, `/data` encryption.
**Tests:** 389 Python (was 362) + 28 TS suites, all green. TypeScript baseline unchanged at 29.

---

## 1. Unauthenticated routes — fixed

### The bug was worse than "no auth"

These routes take the user's identity from `{phone}` **in the URL** — a value the client picks. So there were two holes, and fixing only the first would have been a false sense of safety:

| | Hole | Fix |
|---|---|---|
| **AuthN** | No token at all — anyone could call | Supabase bearer token required |
| **AuthZ** | Even *with* a token, `{phone}` selected whose data you got — a signed-in user could read anyone's by typing their number (**IDOR**) | Storage key comes from the **verified token**; the path phone is only checked for ownership |

`app_auth.storage_key_for()` is where that second rule lives. It returns `caller["key"]` and raises **403** if the path names a number the caller hasn't linked.

### Routes changed

| Route | Before | After |
|---|---|---|
| `GET /tasks/{phone}` | open | 401 / 403 · own tasks only |
| `POST /tasks/{phone}` | open | 401 / 403 · writes to own store |
| `PATCH /tasks/{phone}/{id}` | open | 401 / 403 · id scoped to own store |
| `DELETE /tasks/{phone}/{id}` | open | 401 / 403 · id scoped to own store |
| `GET /agents/{phone}` | open | 401 / 403 |
| `POST /agents/{phone}` | open | 401 / 403 ← **could schedule WhatsApp messages to a stranger** |
| `PATCH /agents/{phone}/{id}` | open | 401 / 403 |
| `DELETE /agents/{phone}/{id}` | open | 401 / 403 |
| `GET /link/verify/{phone}` | open — **user-enumeration oracle** | 401 · answers only "is this linked to *me*" |
| `POST /push/register` | open — **push-hijack** (bind your token to their number) | 401 · phone from token, body ignored |
| `POST /personality/complete` | open — overwrite any user's profile | 401 / 403 · own account only |
| `GET /diag/sync`, `/diag/embed`, `/debug/graph`, `/usage` | open — leaked project ref, key role, spend | `ADMIN_TOKEN` |

`GET /health` stays public (no user data). `POST /agent/chat` already did this correctly and was the pattern copied.

### Two subtleties worth knowing

**`/link/verify` couldn't just require a matching phone** — it's called *before* the link exists, so that would deadlock. Instead it resolves the number's owner and compares to the caller: a stranger's number now reports `linked: false` whether or not they use Lumi, which closes the enumeration channel without breaking the flow.

**`/push/register` no longer trusts `body.phone`.** It uses `caller["phone"]`. The body field is still accepted and ownership-checked, so old clients get a clear 403 rather than silent misbehaviour.

### Fails closed

`app_auth.verify()` raises when Supabase is unreachable or unconfigured, and `require_caller` turns that into a 401. A network blip cannot become an accidental allow.

---

## 2. Secrets

### Audit result

| Finding | Status |
|---|---|
| Supabase **service-role key** client-side | ✅ Clean — server-only, never in `src/` or `web/` |
| Hardcoded keys in source | ✅ Clean — no literals in TS/Python |
| `google-services.json` committed | ⚠️ Expected — Firebase **client** config, designed to ship in the APK. Restrict the key by package + SHA-1 in GCP. Not a leak. |
| `EXPO_PUBLIC_NEBIUS_API_KEY` | ❌ **Ships in the APK, extractable** |
| `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` | ❌ Ships in the APK (restrictable) |

### Why the Nebius key is not deleted in this change

`EXPO_PUBLIC_*` is a **build instruction** ("inline me"), not a security level. But five app services still call the model directly, so deleting the key today silently breaks five screens. The removal is a *migration*, not an edit — it completes when those callers move to `POST /agent/chat` (one screen, `CoachChatScreen`, is already there).

**What is fixed now: regression.** `scripts/prepare-build-env.mjs` classifies every `EXPO_PUBLIC_*` var:

- **Known-exposed** (Nebius, Maps) → loud warning every build, cannot be forgotten.
- **Anything else credential-shaped** (`*_SECRET`, `*_TOKEN`, `*_KEY`, `*_PRIVATE`) → **build fails.**
- Safe-by-name (`*_URL`, `*_ANON_KEY`, `*_CLIENT_ID`) → allowed.

A *new* secret can no longer join the bundle quietly.

---

## 3. Encryption at rest

### What was exposed

Every store on `/data` was plaintext JSON: home addresses, phone numbers, task contents, behavioural notes, conversation excerpts, uploaded CVs. Provider disk encryption doesn't help — the volume is mounted, so any process that reads the path reads the data.

### `server/secure_store.py`

- **AES-256-GCM**, fresh 96-bit nonce per write. Authenticated, so tampering is *detected*, not just hidden.
- **Filename bound as AAD** — a ciphertext can't be moved between stores (dropping `conversations.json` in place of `user_memory.json` fails to authenticate).
- **Self-describing envelope** → plaintext and ciphertext are distinguishable, so no flag day.
- **Atomic writes** (temp + `fsync` + `os.replace`) — also fixes the pre-existing truncation bug.

Stores migrated: `user_memory` · `conversation` · `user_profile` · `user_store` · `known_places` · `travel_prefs` · `provenance` · `bug_reports` · `reminders` · `agents_store`.
Left plaintext deliberately: `llm_usage.json` (no PII).

### Three behaviours, chosen deliberately

| State | Behaviour |
|---|---|
| No key set | Plaintext, exactly as today, warned once. **Staged rollout, no outage.** |
| Key set, file plaintext | Loads fine; next write encrypts it. Migration is a side effect of normal use. |
| Key set, decryption **fails** | **Raises.** Never returns `{}`. |

That third row is the important one. Every store previously answered corruption with `return {}` — and the next save wrote that empty dict over the real data. A wrong or rotated key must not be able to trigger that silent wipe.

### Enabling it

```bash
fly secrets set LUMI_DATA_KEY=$(openssl rand -base64 32) -a lumi-whatsapp
```

⚠️ **Losing this key loses the encrypted data** — by design. Store it in a password manager before setting it. Cost: `cryptography` adds ~4.7 MB RSS (measured), acceptable against ~81 MB headroom.

---

## 4. Verification plan

### A. Automated (run these)

```bash
cd server && python3 -m pytest tests/test_route_authorization.py tests/test_secure_store.py -v
```

**`test_route_authorization.py` — 15 tests**
- every protected route returns 401 with no token / garbage token / non-Bearer scheme
- Alice authenticated **cannot** read, write, or delete Bob's tasks → 403
- Alice **cannot** create an agent under Bob's number → 403
- `/link/verify` does not reveal that Bob owns a number
- Alice's own read/write round-trip still works ← guards against over-blocking
- admin routes reject a wrong token; `/health` stays public

**`test_secure_store.py` — 12 tests**
- ciphertext contains none of: Hebrew contact name, phone, address, task text
- nonce differs per write (GCM reuse would be fatal)
- legacy plaintext migrates on next write
- **wrong key / missing key / tampered byte / moved file → raises, never `{}`**
- no temp files leaked

Full regression: `python3 -m pytest tests/ -q` → **389 passed** · `npm run test:all` → **28/28**

### B. Manual, against the deployed server

```bash
# 1. Unauthenticated → 401
curl -s -o /dev/null -w '%{http_code}\n' https://lumi-whatsapp.fly.dev/tasks/972500000000
# expect 401

# 2. Cross-user with a REAL token → 403
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $YOUR_SUPABASE_TOKEN" \
  https://lumi-whatsapp.fly.dev/tasks/972500000000
# expect 403

# 3. Own data with a real token → 200
curl -s -H "Authorization: Bearer $YOUR_SUPABASE_TOKEN" \
  https://lumi-whatsapp.fly.dev/tasks/$YOUR_PHONE | head -c 200
# expect 200 + your tasks

# 4. Diagnostics closed
curl -s -o /dev/null -w '%{http_code}\n' https://lumi-whatsapp.fly.dev/diag/sync
# expect 401 or 503

# 5. Health still open
curl -s https://lumi-whatsapp.fly.dev/health
```

Get a token: sign in to the app, or Supabase dashboard → Auth → user → access token.

### C. Encryption, on the box

```bash
fly ssh console -a lumi-whatsapp
grep -c "__lumi_enc__" /data/user_memory.json     # 1 = encrypted
grep -o "05[0-9]\{8\}" /data/user_memory.json     # no phone numbers in plaintext
```

### D. Deploy order — matters

1. **Deploy the server first.** Old clients then get 401 on those routes; they already treat a non-ok response as "skip", so this degrades rather than crashes.
2. **Ship the app build** carrying the `Authorization` header.
3. **Then** set `LUMI_DATA_KEY` — files migrate on next write.
4. Optional: force migration now with `secure_store.rotate(path)` per store.

Rollback: `flyctl releases rollback -a lumi-whatsapp`. If `LUMI_DATA_KEY` was already set and files encrypted, **keep the key set** — rolling back the code without it makes those files unreadable.

---

## 5. Client changes

`src/services/serverAuth.ts` (new) — one `authedFetch` helper so the token can't be forgotten per call site. Returns `null` when signed out; every caller maps that to its existing empty/offline path, so offline behaviour is unchanged.

Updated: `AgentsService` (4 calls) · `PushService` (2) · `TaskStorage` (2) · `WhatsAppTaskSync` (1) · `PersonalityHandoffService` (1).

---

## 6. Still open

| Item | Note |
|---|---|
| **Nebius key in the APK** | Needs the 5 remaining screens migrated to `/agent/chat`. Guard prevents regression; migration removes the key. |
| **WhatsApp webhook signature** | `POST /webhook/whatsapp` still doesn't verify `X-Hub-Signature-256` — forgeable. Separate fix, needs the Meta app secret. |
| **JSON store locking** | Writes are now atomic, but two concurrent turns can still lose one. Needs a file lock or a real DB. |
| **Key rotation runbook** | `secure_store.rotate()` exists; no scheduled rotation. |

---

# Round 2 — pre-release review (2026-09-15)

**Why:** Koral is about to hand the app to friends as new users, and wants it on
Google Play. Everything before this round was written for a one-user app where
the only person who could be harmed by a gap was the person who built it. That
assumption expires the moment somebody else signs in.

**Scope:** what ships on the device, what the database enforces, what the server
accepts, what Play refuses. **Tests:** 525 Python (was 518) + 31 TS suites, all
green. TypeScript baseline unchanged at 25.

## 7. What held

Verified against the real artifact and the live project, not from the source's
own claims:

| Checked | Result |
|---|---|
| Server secrets inside the APK | **none** — 16 patterns (Anthropic, DB URL, WhatsApp, HF, LangSmith, Nebius, admin token, `service_role`), all zero |
| The Supabase key that does ship | `role: anon`, never `service_role` |
| RLS coverage | **23 of 23 tables**, every one scoped by `auth.uid()` |
| Route authorization | every app route requires a verified token; `storage_key_for` closes the IDOR |
| Admin gate | `ADMIN_TOKEN` set on Fly, fails closed when unset, constant-time compare |
| Deep-link handoff token | 256-bit, 10-minute TTL, single-use, taken atomically |
| CORS | no middleware, so browsers cannot reach the API cross-origin at all |
| Error handlers | no traceback or internal detail returned to callers |
| `.easignore` | `server/` and every `.env` excluded; only `.env.production` ships |
| Build is not debuggable | confirmed via `aapt dump badging` |

## 8. Rate limits — fixed

Two doors ran a full ReAct turn (up to 15 tool calls on a 235B model) with no
ceiling. **Authentication bounds WHO, never HOW MUCH.**

| Door | Ceiling | Key |
|---|---|---|
| `POST /agent/chat` | 30 / min | the verified account |
| `POST /webhook/whatsapp` | 30 / min | the sender's number |
| `POST /webhook/whatsapp` | 240 / min | the whole door |

The third one is not redundant. A forged flood names a **different** number in
every body, so each request looks like a brand-new user with a full allowance;
only a whole-door ceiling sees it. `server/tests/test_rate_limit_routes.py`
pins that case specifically, so the ceiling cannot later be removed as
duplication.

In-process and dependency-free — this machine has 256 MB and already gave up
LangGraph over 35 MB.

## 9. The production build pointed at an empty environment — fixed

`eas.json` aimed the store profile at the `production` EAS environment, which
holds **one** variable (`EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID_ANDROID`). A Play
upload would have shipped an app that installs, opens, and has no Supabase, no
server and no maps — silently. This is the exact failure CLAUDE.md already
documents, and nothing anywhere would have reported it.

Every profile now loads `preview`, the only environment with the keys. Also
added `cli.appVersionSource: remote` and `autoIncrement: versionCode`, without
which Play rejects the second upload for reusing versionCode 1.
`tests/run-release-config.ts` guards all of it.

## 10. Permissions — fixed

`ACCESS_BACKGROUND_LOCATION` was requested for a feature that **does not
exist**: `startBackgroundLocationUpdates` names a task never registered with
`TaskManager.defineTask`, and has no callers. It is also the most scrutinised
permission on Play — a declaration form and a demo video. Removed and blocked.

Also removed or blocked: `WRITE_CONTACTS` (contacts are only read),
`SYSTEM_ALERT_WINDOW`, `USE_BIOMETRIC`, `USE_FINGERPRINT`,
`READ/WRITE_EXTERNAL_STORAGE` — all pulled in by libraries, used by nothing.

`USE_EXACT_ALARM` **stays**. Waking her up on time is the product, Play's policy
covers alarm and calendar apps, and dropping it would trade a real feature for a
paperwork saving. It needs a declaration at submission — see the checklist.

## 11. Release logs — fixed

236 `console` statements ship, and on a release build they reach logcat. That is
worth keeping (it is how the `.select('id')` regression was caught one minute
after install) but the same channel carried her phone number 53 times in 200
lines, along with task titles and addresses. On a stranger's phone that is their
data.

`babel-plugin-transform-remove-console` was rejected: this repo has no babel
config, and introducing one days before a release to solve a runtime problem —
by deleting the one channel that finds bugs on real devices — is the wrong
trade. Instead `src/utils/logRedaction.ts` silences the narration
(`log`/`info`/`debug`) and redacts phone numbers, emails, JWTs, API keys and GPS
fixes out of whatever `warn`/`error` still carry.

Installed via `src/bootstrapLogging.ts` as the **first import** of `App.tsx`:
imports are hoisted, so a bare call written between them runs *last*.

## 12. Still open — and these need Koral's own hands

| Item | Why it matters | What to do |
|---|---|---|
| **`WHATSAPP_APP_SECRET` unset** | `_signature_ok` returns `True` when it is unset, so `POST /webhook/whatsapp` accepts **unsigned bodies from anyone** — forged messages from any number, each a paid model turn. The rate limits cap the cost; they do not close the door. The code comment claiming no Meta Business account exists is **stale**: `whatsapp_service` posts to `graph.facebook.com` with a business phone id, so the secret is available. | Meta dashboard → App settings → Basic → App Secret, then `fly secrets set WHATSAPP_APP_SECRET=... -a lumi-whatsapp` |
| **Google Maps key unrestricted** | `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` is extractable from the APK by design. Unrestricted, anyone holding the APK can bill her Google account. | Google Cloud Console → restrict to Android package `com.lumi.app` + the release keystore SHA-1 |
| **No privacy policy** | Play **requires** a reachable privacy-policy URL for any app collecting personal data. Lumi collects location, contacts, audio and a personal calendar. Hard blocker. | Publish one and link it in the Play listing |
| **Data Safety form** | Must declare location, contacts, audio, personal info, and that data is sent to a server. | Fill at submission |
| **Her own data in git history** | `server/conversations.json` and `profiles.json` were untracked on 2026-09-15, but remain in history. Repo is private; runtime writes go to `/data`, so no new-user data lands there. | Optional: `git filter-repo`, which breaks every existing clone |
| **Existing `/data` files still plaintext** | `LUMI_DATA_KEY` was set on 2026-09-15, but legacy files migrate only on their next write. New users are encrypted from the start. | Nothing, or force a write |
| **JSON store locking** | Unchanged from round 1: two concurrent turns can still lose one. More likely with several users. | A file lock, or move these stores to Supabase |
