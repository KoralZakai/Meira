# Get Lumi onto your Galaxy S24 (with a hardware push-to-talk key)

Your Lumi app is now a full **PWA** — it installs like a real app, works offline after the first load, and has an app icon. Everything you need is in the **`deploy`** folder in your project (and in `lumi_pwa.zip`).

⚠️ **Why we have to put it online first:** Android blocks the microphone unless a page is served over **HTTPS**. Opening the file directly from storage lets Lumi *talk* and lets you *type*, but the **mic won't work** and it can't install as an app. So we host it once (free, ~60 seconds) and everything works — voice included.

---

## ✅ Easiest deploy — Netlify Drop (free, ~1 minute, permanent link)

1. On your computer, open **https://app.netlify.com/drop** in a browser.
2. Sign in free (Google/GitHub — one click).
3. **Drag the `deploy` folder** (from `...\lumi avsha\deploy`) onto the page.
4. In a few seconds you get a live link like **`https://lumi-sunny.netlify.app`**. (You can rename it in Site settings.)
5. Open that link on your **Galaxy S24 in Chrome**. Done — this is your app URL forever.

> Prefer GitHub? Create a repo, upload the 5 files from `deploy`, then Settings → Pages → deploy from `main` → `/root`. You'll get `https://<you>.github.io/<repo>`. Cloudflare Pages and Vercel work the same way.

---

## 📲 Install it as an app on the S24

1. Open your Netlify link in **Chrome** on the phone.
2. When it asks for the **microphone**, tap **Allow** (needed once for voice).
3. Tap Chrome's **⋮ menu → "Add to Home screen"** (it may say **"Install app"**).
4. Confirm. **Lumi** now appears in your app drawer and on your home screen with her sunny icon, and opens full-screen like a native app.

Enter your name + wake time on first launch and you're set.

---

## 🔘 Assign a hardware key for push-to-talk (the important one)

Because Lumi is installed as a real app, and her app icon opens straight into **listening mode**, you can bind a physical button to launch her:

**Best option — the Side key (built into your S24):**
1. **Settings → Advanced features → Side button.**
2. Under **Double press**, choose **Open app**.
3. Tap the gear/select and pick **Lumi**.
4. Now **double-press the side button** → Lumi opens and immediately starts listening. Speak your command. 🎤

**Alternative — remap a Volume key (works even when screen is off):**
Install **"Button Mapper: Remap your keys"** from Play Store → add a custom action (e.g. **Volume Up → long press**) → **Launch app → Lumi**. Great if you want a dedicated key that isn't the side button.

**Bonus — icon shortcut:** long-press Lumi's home-screen icon → **"Talk to Lumi"** → jumps straight into listening.

> First time only: after you press the key, Chrome may need one tap to confirm the mic — tap anywhere and she starts. After that it's seamless: press key → talk.

---

## ⚡ Want to peek *right now* before hosting?
Copy `deploy/index.html` (or the original `lumi_app.html`) to your phone via Quick Share / email, open it in Chrome. Lumi will appear, animate, **speak**, and you can **type** commands and run the morning briefing. Only the *microphone* waits for the hosted (HTTPS) version above.

---

## What "opening = listening" means
The app's start link is `?talk=1`, so any time Lumi is launched from her icon, the side key, or the shortcut, she wakes up already listening for you — that's your visual, sophisticated push-to-talk. The full native build (Phase 2) can go further with a lock-screen tile and a true global assistant key.
