---
name: ship
description: Test, commit, build and install the Meira APK, then hand the push to the user and check /health after. Use when asked to ship, release or "get this on my phone". Never runs fly deploy and never pushes.
---

# Ship

A push to `master` IS the deploy (`.github/workflows/fly-deploy.yml`), and the push is the user's. This skill never runs `fly deploy` and never pushes.

1. `git fetch`, then rebase the current branch on `origin/master`. Stop and report conflicts; do not guess a resolution.
2. Run the tests. Stop if anything is red.
   - App: `npm run test:all`
   - Server: `cd server && .venv/bin/python -m pytest tests/ -q`
   - Types: `npx tsc --noEmit 2>&1 | grep -c "error TS"`. Report the count against the same command on the base commit; it must not go up.
3. Commit only the files touched for this task, by name. Never `git add -A` / `git add .`.
4. Do NOT run `fly deploy` and do NOT push. Report: **"committed, waiting for your push"**, with the commit SHA.
   After the user says they pushed, run `curl -s https://lumi-whatsapp.fly.dev/health` and report what it returned. A push to a branch other than `master` deploys nothing — say so.
5. Build the APK, then install it. `adb` is not on PATH on this Mac:
   - Build: `npm run android:local` (writes `lumi-local.apk`) or `npm run android:release` (EAS cloud, `preview` profile). Both run `build:env` first.
   - Install: `ADB=/opt/homebrew/share/android-commandlinetools/platform-tools/adb`, then `$ADB devices -l`, then `$ADB -s <serial> install -r <apk>`.
   - If no device is attached, say so clearly. Do not call the fix done.
   - Release builds have no hot reload: a fix is only visible after a new build. Check it on the phone with `$ADB exec-out screencap -p > shot.png` and `$ADB logcat -d -v time -s ReactNativeJS:V`.
6. Summarize in a few lines: what shipped, the installed `versionCode` (`$ADB shell dumpsys package meira.secretary | grep versionCode`), and what is still unverified (not pushed, not deployed, not checked on the phone).
