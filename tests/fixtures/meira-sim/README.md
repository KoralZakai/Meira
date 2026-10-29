# meira-fixtures

Deterministic test data for Meira. Real Israeli locations, three simulated personas,
28 days, and golden files to assert against.

Regenerating produces byte-identical output: randomness is seeded per
`(user_id, date, purpose)`, never globally, so adding a meeting for one user cannot
shift another user's noise and churn every golden file.

```bash
python3 seed_sqlite.py              # -> meira_db.sqlite, stdlib only
python3 generators/simulate.py      # regenerate data/sim_*.csv
python3 generators/gen_mock.py      # regenerate the edge-case set
python3 generators/gen_scenarios.py # regenerate the decision-layer scenarios
```

## Layout

```
data/            CSV fixtures (see tables below)
generators/      the scripts that produced them
schema/          meira_db_schema.sql — 16 tables, 3 views
seed_sqlite.py   builds meira_db.sqlite with FKs and CHECKs ON
PROMPT.md        paste this into Claude Code
```

## The two datasets

**`sim_*` — the 28-day simulation (2026-10-04 .. 2026-10-31).** Three personas living
a month. Use it for integration tests, the learning pipeline and notification behaviour.

| Persona | Mode | Shape of their month |
|---|---|---|
| 101 Ronen Shaked | car | Field engineer, Modi'in. 2–4 customer sites a day across the whole country. Punctual; the road is not. |
| 102 Shani Berkovich | train + bus | Hybrid designer, Rishon LeZion → Tel Aviv. Leaves 5–12 min late every time, misses a connection ~20% of trips. |
| 103 Noa Levi | bike | MSc student, Old North. Short local trips, never late. **Control: any warning for Noa is a false positive.** |

**`edge_*` — the hand-built edge cases.** 12 users, but user 1 ("Maya Test") carries one
deliberate failure per day: cross-country infeasible, mode-dependent failure, tight-by-margin,
online meeting between two physical ones, wake conflict, overlap, and the DST boundary.
Use it for unit tests of the feasibility rule.

## Files

| File | Rows | What it is |
|---|---|---|
| `locations.csv` | 44 | Real places with Google `place_id`, address, lat/lng |
| `sim_users.csv` | 3 | Personas, including their **true** hidden behaviour parameters |
| `sim_meetings.csv` | 144 | The planned schedule |
| `sim_transit_plans.csv` | 128 | Wake / leave-home / arrive, as Meira computed them |
| `sim_notifications.csv` | 315 | Every notification, each tied to a real meeting id |
| `sim_task_events.csv` | 400 | Append-only truth log — the learning input |
| `sim_learning_trace.csv` | 60 | Day-by-day profile state — the convergence curve |
| `sim_feasibility.csv` | 128 | **Golden file.** Expected status per transition |
| `edge_feasibility.csv` | 306 | **Golden file** for the edge-case set |
| `edge_travel_times.csv` | 290 | Fixed travel estimates, incl. `minutes_by_car` |
| `scenarios.json` | 15 | **Decision-layer inputs** — insert / cancel / interview cases |
| `scenarios_expected.json` | 15 | **Golden answers** for those cases |
| `scenarios_summary.csv` | 15 | One line per case, for a quick diff |

## The decision layer

`generators/scheduler.py` is a reference implementation of three capabilities, all
deterministic and LLM-free. Treat it as the spec, not as code to copy.

| Function | Question it answers |
|---|---|
| `can_insert()` | A meeting arrives at a location — does it fit right here? |
| `when_possible()` | It doesn't fit. Requested day first, then the next 7 working days, cheapest 3. |
| `on_cancel()` | A meeting is dropped — what window opens, and which pending items now fit it? |
| `review_interview_slots()` | The user offers candidate times — rank them and propose three. |

**Why no LLM here.** These are constrained searches over a small space with a scoring
function. An LLM gives a different answer on rerun, can't be unit-tested, and costs a
round trip per candidate — the same argument that keeps the personality scorer
zero-LLM. The LLM phrases the result; it does not compute it.

### Scoring

Cost is in penalty minutes, lower is better, weights in one block at the top of
`scheduler.py`:

| Term | Default | Meaning |
|---|---|---|
| `travel` | 1.0 | per minute of door-to-door travel created |
| `dead_time` | 0.6 | per minute of idle waiting created, above a 30-min grace |
| `early_wake` | 1.5 | per minute the required wake is before the user's normal wake |
| `rush` | 0.4 | per travel minute departing inside a rush window |
| `tightness` | 2.0 | per minute of margin the slot is short of comfortable |
| `cluster_bonus` | 25.0 | flat credit when the slot is within 2.5 km of an adjacent meeting |

Every term that fires is recorded in the option's `reasons`, so a failing assertion
tells you which term moved, not just that a number changed.

### Interview-slot policy

The user's own offered times rank above Meira's suggestions even when a suggestion is
cheaper — they picked those times because they suit the interviewer too, which no cost
function here can see. When a suggestion does beat a chosen slot, it's surfaced on that
slot as `cheaper_alternative`, so the UI can offer the trade rather than silently
overriding the user. Flip this by sorting `recommended` on cost alone.

## Three gaps this fixture does not cover

These are real and the app will need them; they're called out rather than faked.

1. **No venue opening hours.** The engine will happily propose a dentist at 19:30.
   `locations.csv` has the Google `place_id` for every location and Places returns
   `weekday_hours` — wire that in and the constraint becomes free.
2. **No clock.** The fixture has no "now", so `when_possible()` can suggest a slot
   earlier in the week than the request. The app must pass a `now` and never return a
   past slot.
3. **No movability.** `on_cancel()` reports and suggests; it never moves an existing
   meeting. Doing that needs an `is_movable` or `priority` column per meeting.

## Conventions

- `start_at` / `end_at` / `fire_at` / `occurred_at` are **UTC** ISO-8601 with `Z`.
- `date`, `start_local`, `end_local` are **Asia/Jerusalem**. The month crosses DST
  on 2026-10-25, so 09:00 local is `06:00Z` before it and `07:00Z` after. Any code
  that does `local + fixed_offset` fails on 2026-10-26 in this data.
- Durations are integer minutes. Booleans are 0/1.
- Homes are **neighbourhood centres**, not real residential addresses.
- Travel minutes are **estimates from a distance model**, not Google Directions.
  Replace `edge_travel_times.csv` with real routes and rerun the generator; the
  golden files recompute from whatever is in the table.

## Feasibility rule the golden files encode

```
position   = last PHYSICAL location (home at day start); online meetings don't move you
margin     = buffer_minutes + max(0, avg_lateness_minutes)
gap        = next.start_at − prev.end_at

OVERLAP            gap < 0
INFEASIBLE_TRAVEL  gap < travel
TIGHT              gap < travel + margin
OK                 otherwise
WAKE_CONFLICT      first physical meeting needs a wake before earliest_wake_time
```

Online meetings take travel 0 and margin 0: only `OVERLAP` can fail them.

## Findings baked into this data

**Never learn the margin from arrival lateness.** The margin makes the user arrive
early, so measured lateness goes negative and the margin can never shrink again — a
feedback loop on the system's own output. The simulator learns from two independent
causes (departure delay, travel ratio) and keeps arrival lateness as a reported KPI only.

**The driver's calendar has no room for an interview at all.** Ronen cannot fit a
90-minute interview inside any of his 20 working days — every offered slot fails.
`INT-02` asserts that Meira falls back to edge-of-day slots instead of answering "no".

**A recurring commitment can flip verdict week to week.** Shani's Tuesday
17:30 Sarona → 18:30 TAU is `INFEASIBLE_TRAVEL` one week and `TIGHT` the next on an
identical calendar, purely because the learned bias moved. Per-instance warnings will
look inconsistent to the user; the pattern is what needs reporting.

## Schema changes made for this fixture

- `places.user_id` is now nullable — `NULL` means a shared place (a company, a station).
  Only a user's home is owned by them. Added `'station'` to the `kind` list.
- `users` gained `buffer_minutes` and `earliest_wake_time`; the feasibility check
  needs both and neither was expressible before.
