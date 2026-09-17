# Lumi — Character Design Spec

**Meaning of the name:** Lumi → *luminance / light / sun.* Everything about her reads warm, bright, and welcoming.
**Role:** Your personal assistant avatar. Smiley, encouraging, engaging, always greets you.
**Format:** 3D VRM character (built in VRoid Studio), rendered on Samsung Galaxy S24 via ChatdollKit (Unity).

---

## 1. Visual identity (v1 — "Sunny")

| Feature | Spec |
|---|---|
| **Hair** | Blonde, warm golden tone (#F7DE8B → #EEC65A), shoulder-length with soft bangs and side sweeps |
| **Eyes** | Green (#4FA96B / #3E8F57), bright and friendly, with catch-light highlights |
| **Freckles** | Light scatter across cheeks and nose bridge (#D79A6E) |
| **Glasses** | Stylish cat-eye frames, dark slate (#3A4A52) — the signature accessory |
| **Expression** | Big warm smile — her default is a **greeting** |
| **Cheeks** | Soft rosy blush (#F7A9BE) |
| **Outfit** | Baby pink shirt (#FBD7E4 → #F6BBD1) with a soft collar |
| **Aura** | Subtle sun rays + sparkles behind her (the "Lumi" light motif) |

Reference art: `lumi_concept.svg` (2D concept to guide the 3D VRoid model).

## 2. Personality & voice
Bright, upbeat, warm, lightly playful. She celebrates your wins, never nags. Think "encouraging morning-sun energy." Voice: friendly, mid-pitch, expressive — pair with an expressive TTS voice and match viseme timing for lip-sync.

Greeting behavior: whenever summoned, Lumi **waves, smiles, and greets** ("Hey! What can I do for you?") before listening.

---

## 3. Gesture & animation library (make her *engaging*)

Lumi should almost always be doing *something* — no dead stares. In ChatdollKit these fire via animation tags like `[anim:wave]` and expression tags like `[face:Joy]`, driven by the conversation's sentiment and state.

**Idle / ambient (always running)**
- Gentle breathing sway, occasional weight shift
- Natural blinking (every 3–6s), small head tilts
- Hair/cloth micro-motion, eyes track the user

**Greeting / attention**
- `wave` — big friendly wave on summon
- `peace_sign`, `head_tilt_smile`, `lean_in` (when you start talking)

**Listening**
- Attentive nod, `head_tilt`, hand-to-chin "I'm listening"

**Thinking / processing**
- `tap_chin`, `look_up_pondering`, finger-to-temple, slight sway

**Speaking (sync to content)**
- Open-hand `present` gesture, counting on fingers for lists
- `point` (when referencing something), `shrug` (uncertainty)

**Reactions / emotion**
- `celebrate` / `clap` / `thumbs_up` (task done, good news)
- `cheer_arms_up`, `heart_hands` (affection/encouragement)
- `gasp_surprise`, `thoughtful_frown` (concern), `giggle`

**Expressions (VRM blendshapes)**
- Joy, Neutral, Fun, Surprised, Sorrow, Wink, plus mouth visemes (A/I/U/E/O) for lip-sync

**Mapping rule:** the backend tags each response with an emotion + optional gesture (e.g. reminder set → `[face:Joy][anim:thumbs_up]`), and ChatdollKit plays it. Keep a weighted random pool per category so she never repeats the exact same motion twice in a row.

---

## 4. Changing her looks anytime (a core requirement)

Lumi's appearance is **data, not code.** Two layers keep it swappable forever:

1. **Swappable VRM models** — ChatdollKit supports runtime VRM switching. Keep multiple `.vrm` files (e.g. `lumi_sunny.vrm`, `lumi_winter.vrm`, `lumi_formal.vrm`) and switch on command ("Lumi, change into your winter look").
2. **Appearance config** (`lumi_appearance.json`) — a single file describing the *active* look (hair color, eye color, outfit, accessories, which VRM, voice). Editing this file (or later, a settings screen) changes Lumi with no rebuild. See the accompanying `lumi_appearance.json`.

**Future "avatar designer" screen:** expose the config fields as pickers (hair color, eye color, outfit, glasses on/off, freckles slider) and, for bigger changes, let the user drop in a new VRM they made in VRoid. Because everything already routes through the config + VRM-switch API, the designer UI is additive — no rework of the core app.

---

## 5. Build notes
- Model v1 "Sunny" in **VRoid Studio** using the specs in §1 → export `lumi_sunny.vrm`.
- Import into **ChatdollKit**, register the gesture set from §3 as animation clips (Mixamo FBX clips work well), map emotion tags.
- Wire greeting-on-summon, then connect the hybrid brain (cloud LLM + on-device fallback).
