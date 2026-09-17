# Making Lumi "always alive like WhatsApp" — setup steps

The code changes are done. These are the steps only **you** can run (they need your
Fly / Expo / Firebase accounts and your database). Do them in order.

---

## Part A — Backend deploy  ✅ code done, just deploy

**Superseded 2026-09-08: the backend is no longer always-on.** `fly.toml` now sets
`auto_stop_machines = 'stop'` / `min_machines_running = 0` so the machine sleeps when
idle and the free tier costs $0. Fly wakes it on any request, including Meta's webhook.

What that costs: nothing that has to ring on time. The **phone** owns departure alerts
now (`server/reminders._app_owns_departures`), and local alarms fire with the app closed.
Standalone WhatsApp reminders ("remind me at 15:00") are the exception — they need the
machine awake and will fire late until something pings `/health` on a schedule.
To go back to always-on, set both values back (`'off'` / `1`) and expect a bill.

There is exactly ONE fly config, at the repo root. Run:
```bash
fly deploy -a lumi-whatsapp -c fly.toml
```
```bash
curl https://lumi-whatsapp.fly.dev/health
```
If `/health` fails: the container binds `${PORT:-8000}` and `fly.toml` routes to `8000`.
If a `PORT` secret is set to something else, unset it or match `internal_port`.

**Apply the new DB migrations** (once) against your Postgres — for the handoff token and
push token columns:
```bash
psql "$DATABASE_URL" -f server/database/migrations/002_personality_handoff.sql
psql "$DATABASE_URL" -f server/database/migrations/003_push_token.sql
```

---

## Part B — Installable Android build

The app can't be "installed like WhatsApp" until it's a real build (Expo Go can't do
push and won't fire notifications when closed).

1. `eas login`
2. `eas init` — this replaces the `"placeholder"` in `app.json` → `extra.eas.projectId`
   with a real id. Commit that change.
3. Build an installable APK:
   ```bash
   npm run android:release      # eas build -p android --profile preview
   ```
4. Install the resulting APK on your phone.

---

## Part C — Push notifications (reach the phone even when the app is closed)

Code is done on both sides. Two setup steps + one in-app action:

### 1. Firebase / FCM credentials (required for Android push)
- Create a Firebase project, add an Android app with package **`com.lumi.app`**.
- Generate an **FCM v1 service-account key** (JSON) in Firebase → Project settings →
  Service accounts.
- Upload it to Expo so Expo's push service can deliver to Android:
  ```bash
  eas credentials        # Android → Google Service Account → FCM V1 → upload the JSON
  ```

### 2. Server URL is already wired
The live backend is **`https://lumi-whatsapp.fly.dev`** — it is the one that serves
`/link/verify` and `/diag/sync`. (`lumi-my-ai-assistant.fly.dev` is an old deploy that
answers `/health` and nothing else, so pointing at it fails in a very confusing way.)

The value lives in the EAS **preview** environment, not in a committed file. Run
`npm run build:env` before building; it pulls the environment and refuses to build if
anything required is missing.

### 3. Link the phone (in the app, once)
- Open the app → **Profile/Settings** → enter your **WhatsApp number** (the one you
  message Lumi from) → tap **🔔 Enable phone alerts**.
- This registers the device's Expo push token against your user on the server. From then
  on, every reminder fires over **both** WhatsApp and an app push (see
  `server/reminders.py` `_push_if_registered`).

> Note: linking needs you to have messaged Lumi on WhatsApp at least once (so a user row
> exists for that number), and a real build (Part B) — not Expo Go.

---

## What was intentionally NOT built
- **Native device clock alarms** — Lumi uses notifications by design. (Feasible on
  Android via `AlarmClock.ACTION_SET_ALARM` if you want it later — Android only; iOS
  has no API for it.)
- **The Likert/continuous-scoring personality system** from `LUMI_PERSONALITY_TEST.md`
  — you chose to keep the current binary quiz + add the parity test instead.

## Tests
- Server: `cd server && python -m unittest test_personality_parity` (11 tests).
- App↔server scorer parity: `npm run test:parity`.
