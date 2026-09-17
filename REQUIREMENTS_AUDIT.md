# Lumi — Requirements Audit
**Date:** 2026-08-28 · every line checked against the code, not from memory.

Legend: ✅ works · 🟡 partial · ❌ missing

---

## Scorecard

| # | Requirement | State |
|---|---|---|
| 1 | Intelligent personal time management | 🟡 |
| 2 | Dynamic schedule planning | 🟡 |
| 3 | Smart wake-up & preparation | 🟡 |
| 4 | Multi-modal & dynamic transportation | 🟡 |
| 5 | Location-aware intelligence | 🟡 |
| 6 | Proactive task management | 🟡 |
| 7 | Real-time replanning | ❌ |
| 8 | Productivity & well-being | ❌ |
| 9 | Personal learning & behavioural intelligence | 🟡 |
| 10 | Autonomous daily manager | ❌ |

Nothing is fully done, and nothing is untouched. The recurring shape: **the
computation exists, but only on one of the two brains, and often with no
consumer.**

---

## 1. Intelligent personal time management 🟡

Tasks carry priority, duration, category, deadline and `latestStartBy`, and are
sorted priority → `leaveHomeBy`. That is scheduling, not time management: Lumi
never reasons about how much time is *left* in a day or what fits.

**Missing:** free-time computation; "you have 35 minutes" awareness.

## 2. Dynamic schedule planning 🟡

`ensureTravelChain` (GoogleSync) builds a real chain — place to place, not
always from home — and re-plans when the schedule implies a different start.

**Update 2026-08-28:** the SERVER now chains the whole day (`daychain.py`) — adding a task shifts every later trip's leave time, place-to-place. The app's `optimize_day` still only sorts, though:

**`optimize_day` does not optimize.** `LLMService.ts:644` in full:

```ts
const sorted = sortTasksByPriorityAndTime(remaining);
return { tasks: sorted, ... };
```

It sorts. None of the documented rules (work in the morning, gym after the work
block, calls at the end, 10-minute buffers, never past `sleepTime`, group
nearby locations) are implemented.

**Missing:** an actual optimizer.

## 3. Smart wake-up & preparation 🟡

Backward calculation works and is the strongest part of the product: arrival →
travel → `leaveHomeBy` → routine → `wakeUpBy`, with the wake alarm correctly
suppressed when the day does not start early (`needsWakeAlarm`).

But the routine is **one opaque number**. Only `morningRoutineMinutes` and
`wakeBufferMinutes` exist — there is no shower, breakfast, or per-task
preparation step, so none of them can be learned or adjusted separately.

**Update 2026-08-28:** the wake alarm now fires for a commitment with NO journey (was routed-trips-only), and is a user toggle in Settings.

**Missing:** a decomposed routine (shower / breakfast / prep), each learnable.

## 4. Multi-modal & dynamic transportation 🟡

`geo._MODE_MAP` supports exactly five modes:

```python
{"car": "driving", "bus": "transit", "train": "transit",
 "walk": "walking", "bike": "bicycling"}
```

**Not supported:** scooter, motorcycle, taxi, ride-sharing. Tram/light-rail
appear only as Google *vehicle types* inside a transit leg — they cannot be
requested or preferred.

Multi-modal journeys **do** work (walk → bus → walk arrives as real legs), but
only as Google returns them; Lumi cannot compose "scooter → train".

Selection is **not dynamic**: no traffic, cost, weather or availability input.
As of today it is preference-driven — `travel_prefs` learns the mode per place
and per category, which is new and working.

**Missing:** scooter/motorcycle/taxi/rideshare; per-mode availability and
constraints; weather/cost/traffic-aware selection.

## 5. Location-aware intelligence 🟡 → nearly ✅

`NearbyTaskReminderService` fires "you are near X", AND — new 2026-08-28 —
`positionDrift.ts` finally has a consumer: `LiveRoute` re-plans the next trip
from her real GPS position inside HomeScreen's existing 2-minute loop, and tells
her when the leave time changed. The "leave time computed at home, shown
unchanged across town" gap is closed for the next trip.

**Still missing:** it acts on the foreground loop only (no re-plan while the app
is backgrounded), and on the single next trip rather than the whole remaining
chain.

## 6. Proactive task management 🟡

`GapSuggestionCard` and `suggest_gap_filler` exist and render.

But suggestions are not grounded in *available time* or *route proximity* —
there is no "you are already passing the post office".

**Missing:** gap detection from the real timeline; on-route task surfacing.

## 7. Real-time replanning ❌

The honest answer: **nothing watches reality.**

GoogleSync re-plans on a refresh window, but nothing reacts to a train delay, a
meeting running long, or her leaving late. `lastDepartureDetectedAt` is now
recorded, and the lead-time model uses it — but only to warn *earlier next
time*, never to recalculate *today*.

**Missing:** the whole feature. This is the largest gap against the vision.

## 8. Productivity & well-being ❌

Nothing. No water, meal, rest, sleep or movement prompts exist anywhere — the
only match in the codebase is the string "Take a break" inside `mbti.ts`.

**Missing:** the whole feature.

## 9. Personal learning & behavioural intelligence 🟡

Genuinely learning today:

| Signal | Where |
|---|---|
| Task duration per category | `LearningService` (70/30 rolling) |
| How late she leaves | `leadLearning` → `learnedLeadMinutes` |
| Transport mode per place/category | `travel_prefs` (new) |
| Where an activity happens | `known_places` (new) |

**Missing:** how long she really takes to get ready; which places she visits
most; when she prefers to exercise or study; which routines she fails to keep;
how much buffer she personally needs.

Also: **embeddings are off.** `EMBED_MODEL` is unset, so the semantic matching
in the brief ("yoga" ≈ "training" ≈ "workout") runs on a hand-written bilingual
lexicon instead of vectors.

## 10. Autonomous daily manager ❌

Of the eight questions the vision says Lumi should answer continuously, it can
answer three — *when should I wake up*, *when should I leave*, *how should I get
there*. It cannot answer *what should I do now*, *what can I accomplish on the
way*, *am I going to be late*, *what changes if something goes wrong*, or *how
do I use the next hour better*.

Lumi is currently **reactive**: it answers when addressed. The vision is a layer
that watches the day and speaks first.

---

## The structural blocker

**Two brains.** Every gap above is worse because the logic exists twice:

- **App** (TypeScript, on the phone): `LLMService`, `LumiCoachEngine`,
  `TaskParser`/`TaskIntent`/`TaskSplitter`
- **Server** (Python, on Fly): `lumi_agent.py` — the only path WhatsApp can
  reach

`LumiCoachEngine.ts` line 2 states the intent — *"the single brain both the app
Chat tab and the WhatsApp bot should route through"* — and WhatsApp never
routed through it.

Requirements 7 and 10 are **not buildable twice**. A watcher that re-plans the
day has to be one thing, running continuously, on the server.

---

## Next, in order

1. ~~**Session + provenance**~~ — **done 2026-08-28** (`provenance.py`). Every
   task now records channel, session and turn, and the `source: 'voice'` bug on
   WhatsApp tasks is fixed on both sides.
2. **Move the travel chain server-side** — *in progress*. Done: the server
   routes deterministically, persists the route onto the task, records
   `originAddress`, and chains multiple trips within one message. Remaining: the
   server plans only the trips a single message creates, while the app still
   chains the whole DAY across messages — so `ensureTravelChain` cannot be
   retired yet. Retiring it also makes the app depend on the server being
   reachable, which is a deliberate design decision, not a refactor.
3. **Real-time replanning (#7)** — a server watcher on delays and overruns.
   Needs step 2.
4. **Live GPS (#5)** — give `positionDrift.ts` its consumer.
5. **A real `optimize_day` (#2)** — implement the documented rules.
6. **Decompose the morning routine (#3)** — shower/breakfast/prep, each learned.
7. **Extend transport (#4)** — scooter, motorcycle, taxi, rideshare + constraints.
8. **Well-being (#8)** — the smallest to start, the easiest to overdo; gate it
   behind the notification budget so it does not become noise.
9. **Enable embeddings (#9)** — set `EMBED_MODEL`; the code path already exists.

Steps 1–2 are prerequisites for most of the rest. Nothing above #3 is worth
starting before the brains are one.
