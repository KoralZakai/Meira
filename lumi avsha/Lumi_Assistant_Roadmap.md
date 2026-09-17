# Lumi — Animated Avatar Personal Assistant

**Target device:** Samsung Galaxy S24 (Android 14+, Snapdragon 8 Gen 3 / Exynos 2400)
**Vision:** Press a button → an animated, designable avatar ("Lumi") appears and helps with daily tasks. Siri, but visual, customizable, and extensible.
**Date:** 2026-07-10

---

## 1. How to think about the build

Lumi is really three separate systems glued together. Decide each one independently — mixing the best option for each beats adopting any single repo wholesale.

1. **The Face** — how the avatar looks and animates (2D vs 3D, lip-sync, expressions).
2. **The Brain** — speech-in → LLM → speech-out (STT, LLM, TTS, memory).
3. **The Hands** — the capabilities ("add anything I desire"): calendar, reminders, messages, web, smart home. This is tool-calling / MCP.

The app shell + summon button just wraps these on the S24.

---

## 2. The repos you found — honest assessment

| Repo | What it really is | Fit for Lumi |
|---|---|---|
| **ChatdollKit** (uezo) | Mature Unity SDK: turn any 3D/VRM model into a voice chatbot. Apache-2.0, ~1.2k★, active (v0.8.16, Feb 2026). Builds to **Android/iOS**. Supports Claude, GPT, Gemini; OpenAI/Azure/Google TTS+STT; VRM runtime model switching, lip-sync, expression + gesture tags, tool calling. | **Strongest single starting point.** It already does Face + Brain + basic Hands on Android. |
| **TalkMateAI** (kiranbaby14) | Web demo (Next.js + FastAPI) using the TalkingHead JS lib, Whisper, Kokoro TTS. MIT, ~94★, early. **Not mobile.** | Great **reference** for browser lip-sync; not the app itself. |
| **RobotAI_Assistant_Mobile-App** (Arjunsuryas) | React Native/Expo app with a pulsing *robot* UI. The "avatar" is a stylized reactive blob, not a designable character. | Good **starter UI** if you go React Native, but it doesn't solve the avatar you want to design. |

## 3. Other repos worth knowing (from research)

- **Open-LLM-VTuber** — the best open-source blueprint for **the Brain**. Hands-free voice, voice interruption/barge-in, Live2D talking face, long-term memory, runs locally, swappable LLM/ASR/TTS. Desktop/web today, but its backend is exactly the architecture Lumi needs — reuse it and put a mobile client on top.
- **met4citizen/TalkingHead** — JS class for real-time full-body 3D (GLB) avatars with lip-sync; the engine behind TalkMateAI. Best if you ever render the avatar in a WebView.
- **Scthe/ai-iris-avatar** and **NeuralHarbour/LLM-Based-3D-Avatar-Assistant** — Unity + LLM + TTS + lip-sync reference projects (GATEBOX-style).
- **undreamai/LLMUnity** — run LLMs *inside* Unity, incl. on-device, if you want offline responses.
- **software-mansion/react-native-executorch** — on-device AI models in React Native (Whisper, small LLMs) — relevant since the S24 can run these.
- **Live2D routes:** `live2d-react`, `flutter_live2d_plugin`, `ReactNative-live2d` (WebView) — if you choose 2D.

---

## 4. Choosing the Face (this decision forks everything)

| Option | Look | Design tool | Mobile rendering | Trade-off |
|---|---|---|---|---|
| **3D / VRM** | Full 3D character, turns, gestures | **VRoid Studio** (free) → export .vrm | Unity (ChatdollKit) — clean on S24 | Richest + most "designable"; Unity is the whole app |
| **2D / Live2D** | Anime-style, very expressive face | Live2D Cubism | WebView or Live2D SDK | Lighter, charming; less "3D presence"; Cubism license tiers |
| **Stylized 2D** | Rive/Lottie reactive character | Rive editor | Native RN/Flutter | Easiest to ship; least lifelike |

For "design the looks + sophistication like a real character," **3D VRM via VRoid + Unity/ChatdollKit** is the sweet spot on a Galaxy S24. You (or a designer) sculpt Lumi in VRoid, drop the .vrm into ChatdollKit, and she talks.

---

## 5. Recommended architecture for Lumi (Android-first)

```
Galaxy S24 App
├─ App shell + "summon" button (floating overlay / launcher)
├─ THE FACE:  Unity + ChatdollKit  ──loads──>  Lumi.vrm (made in VRoid)
│              lip-sync • blink • [face:Joy] • [anim:wave]
├─ THE BRAIN (backend service, FastAPI — modeled on Open-LLM-VTuber)
│    Mic → STT (Whisper / cloud) → LLM (Claude or GPT, streaming)
│         → TTS (with viseme timing for lip-sync) → speaker
│    + long-term memory (vector store)
└─ THE HANDS: tool-calling / MCP servers
     calendar • reminders • messages • email • web search • smart home • notes
```

Start cloud-first for the LLM (fastest to a working Lumi), then optionally move small models on-device (S24 can run Whisper-tiny and small LLMs via ExecuTorch/LLMUnity) for offline/privacy.

**Why a backend?** It lets you add capabilities without shipping a new app each time, keeps API keys off the device, and mirrors how Open-LLM-VTuber already solved voice interruption + memory.

---

## 6. Phased build plan

**Phase 0 — Design Lumi (1–2 wks)**
Decide 2D vs 3D. If 3D: model Lumi in VRoid Studio, export .vrm. Lock her look, palette, personality/voice.

**Phase 1 — She appears and talks (2–3 wks)**
Clone **ChatdollKit**, load Lumi.vrm, build to the S24. Wire Claude/GPT + a cloud TTS/STT. Goal: press button → Lumi appears → you speak → she answers with lip-sync.

**Phase 2 — The Brain (2–4 wks)**
Stand up the FastAPI backend (borrow structure from Open-LLM-VTuber): streaming LLM, memory, voice interruption. Point the Unity app at it.

**Phase 3 — The Hands (ongoing)**
Add capabilities as tools/MCP servers, one at a time: reminders, calendar, weather, messages, web. This is the "add any capability I desire" layer — each new skill is a new tool, not a rewrite.

**Phase 4 — Polish**
Wake word or floating overlay summon, richer expressions/gestures tied to sentiment, on-device model options for offline use, personality tuning.

---

## 7. Fastest path to a "wow" prototype
Clone **ChatdollKit** → run its sample on the S24 → swap in a Lumi VRM from VRoid → plug in your Claude/OpenAI key. You can have a talking, designed Lumi on your phone before writing any backend, then grow the Brain and Hands from there.

---

## Sources
- ChatdollKit — https://github.com/uezo/ChatdollKit
- TalkMateAI — https://github.com/kiranbaby14/TalkMateAI
- RobotAI_Assistant_Mobile-App — https://github.com/Arjunsuryas/RobotAI_Assistant_Mobile-App
- Open-LLM-VTuber — https://github.com/Open-LLM-VTuber/Open-LLM-VTuber
- TalkingHead — https://github.com/met4citizen/talkinghead
- ai-iris-avatar — https://github.com/Scthe/ai-iris-avatar
- LLM-Based-3D-Avatar-Assistant — https://github.com/NeuralHarbour/LLM-Based-3D-Avatar-Assistant
- LLMUnity — https://github.com/undreamai/LLMUnity
- react-native-executorch — https://github.com/software-mansion/react-native-executorch
- VRoid Studio — https://vroid.com/en/studio
- Live2D Cubism — https://www.live2d.com/en/
