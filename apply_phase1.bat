@echo off
REM ── Lumi Phase 1: commit + deploy helper ─────────────────────────────
REM Run this from: C:\Users\kali-linux\Projects\My-AI-Assistant
cd /d C:\Users\kali-linux\Projects\My-AI-Assistant

echo [1/4] Clearing stale git locks (left by the cloud session)...
del /f .git\HEAD.lock 2>nul
del /f .git\index.lock 2>nul
del /f .git\HEAD.lock.stale1 2>nul
del /f .git\index.lock.stale1 2>nul

echo [2/4] Committing the Phase 1 fixes on feature/lumi-upgrade...
git checkout feature/lumi-upgrade
git add server/supabase_tasks.py server/user_memory.py src/services/supabaseRepo.ts
git commit -m "Phase 1: non-clobbering task persistence + non-destructive cloud sync"

echo [3/4] Deploying the server to Fly (WhatsApp brain)...
echo    -- if you don't want to deploy yet, press Ctrl+C now --
pause
fly deploy

echo [4/4] Done. To test the app side on your phone, run:
echo     npx expo start --dev-client
echo or build an installable APK:
echo     npm run android:release
pause
