# START_HERE — Claude Code prompt for the meira-sim fixtures

Paste everything below the line into Claude Code from the repo root.

---

`tests/fixtures/meira-sim/` is a new fixture set: three simulated personas living 28 days
across real Israeli locations, with golden files for feasibility, notifications, learning,
and a decision layer (insert / cancel / interview-slot ranking). Read
`tests/fixtures/meira-sim/README.md` first — it documents the personas, the time
conventions, and the exact rules the golden files encode.

**This repo already has ~80 tests, and several cover the same ground.** I do not want a
parallel suite. Your first job is to work out what is genuinely new here and what is
duplication, and tell me before writing a single test.

## Hard rules

1. **Never edit anything in `tests/fixtures/meira-sim/data/`** to make a test pass. Those
   are the specification. If something fails, either the app is wrong or the fixture
   encodes a rule this app deliberately implements differently — investigate and tell me
   which. Changing an expected value to match actual output is the one thing I don't want.
2. **Don't weaken an assertion to get green.** No widened tolerances, no
   `if status in (...)`, no skipping a failing case.
3. **Test the real code.** Import `resolveClashes`, the real planner, the real notification
   scheduler. Do not reimplement a rule inside a test file and then test your own copy.
4. **Don't delete or rewrite existing tests** to resolve a conflict. If an existing test and
   a fixture disagree, that disagreement is the finding — report it.
5. If something won't run, stop and tell me. Don't mock the thing you couldn't run.

## Phase 0 — reconcile with what already exists. Report before writing code.

These existing tests look like they overlap. For each, tell me in one line what it already
covers and whether meira-sim adds anything:

| Area | Existing |
|---|---|
| Feasibility / clashes | `run-clash-resolution.ts`, `run-clash-parity.ts`, `fixtures/clash-golden.json` |
| Finding a slot | `run-gap-slots.ts`, `run-day-planning.ts`, `run-week-schedule.ts` |
| Interview slots | `run-interview-rules.ts`, `run-ceva-interview.ts` |
| Notifications | `run-alert-integrity.ts`, `run-alert-cancellation.ts`, `run-alert-coverage.ts` |
| Learning | `run-lead-learning.ts` |
| Personas | `run-personas.ts` |
| Travel | `run-departure-options.ts`, `run-multi-stop.ts`, `run-route-failure.ts`, `run-travel-preference.ts` |
| Replanning | `run-live-replan.ts`, `run-disruption.ts`, `run-day-evolution.ts` |
| Overlap semantics | `run-overlap-kind.ts`, `run-yield-to-fixed.ts` |

Then classify every part of meira-sim as one of:

- **Redundant** — an existing test already covers it. Say so and we drop that part.
- **Better data for an existing test** — the rule is covered but the fixture is thin.
  Proposal: extend the existing test's fixture, don't add a new runner.
- **Genuinely new** — no existing test covers it. Only these earn a new `run-*.ts`.

Stop there and show me the classification and your plan.

## Phase 1 — the differential test (this is the valuable part)

`src/utils/resolveClashes.ts` and `server/clashes.py` are two implementations of one rule,
with `run-clash-parity.ts` keeping them honest. `generators/scheduler.py` in the fixture
folder is a **third, independently written** implementation of the same feasibility rule.
Three-way agreement is a much stronger signal than two.

Run `resolveClashes` over `data/sim_meetings.csv` + `data/edge_meetings.csv` and compare its
verdicts against `data/sim_feasibility.csv` and `data/edge_feasibility.csv`. Report a
confusion matrix — expected status vs actual — and list every disagreeing row.

Read `generators/scheduler.py` for the rule the golden files encode, especially:

- Position is the last **physical** location; an online meeting occupies time but does not
  move you, and takes travel 0 and margin 0.
- `margin = buffer_minutes + max(0, learned departure delay)`.
- `OVERLAP` < `INFEASIBLE_TRAVEL` < `TIGHT` < `OK`, plus `WAKE_CONFLICT` for the first
  physical meeting of the day.

Where the two disagree, work out which is right. Do not assume the fixture wins — it was
written in a separate session against a schema I designed there, not against this code.

## Phase 2 — the cases worth adding, if Phase 0 says they're new

- **Noa Levi (user 103) is a control.** All 40 of her transitions are `OK`. Any warning the
  app raises for her is a false positive — report each one.
- **The DST boundary.** Israel leaves DST on 2026-10-25. In `edge_meetings.csv` 09:00 local
  is `06:00Z` before it and `07:00Z` after. Any `local + fixed_offset` arithmetic breaks on
  2026-10-26. Assert on that date explicitly.
- **Phantom notifications.** All 315 rows in `sim_notifications.csv` carry a real
  `meeting_id`, and 24 meetings are online. Replay the month through the notification
  scheduler: every notification must resolve to a real meeting, no duplicate
  `(user, type, target, fire_at)`, and no online meeting may produce a transit plan.
  Compare with what `run-alert-integrity.ts` already checks.
- **Learning signal.** Check which signal sets the margin. If it's arrival lateness, that's
  a bug: the margin makes the user arrive early, measured lateness goes negative, and the
  margin can never shrink — a feedback loop on the system's own output. The fixture learns
  from two independent causes (departure delay, travel ratio) and treats arrival lateness
  as a reported KPI only. Tell me what `run-lead-learning.ts` currently does.
- **Decision layer.** `data/scenarios.json` has 15 cases (8 insert, 3 cancel, 4 interview)
  with golden answers in `scenarios_expected.json`. Compare against `run-interview-rules.ts`
  and `run-gap-slots.ts`. On `INT-03` all three offered slots are workable, so ranking is
  the only thing under test — if this app ranks differently, show both orderings and why.

## Phase 3 — conventions, if we add anything

Match the existing suite exactly: a standalone `tests/run-<name>.ts` run with `npx tsx`, a
`test:<name>` script in `package.json`, appended to `test:all`, bilingual output where the
neighbouring tests are bilingual. Follow the self-updating golden pattern in
`run-clash-parity.ts` only where it already applies — the meira-sim golden files are
checked in and must not be rewritten by a test run.

`seed_sqlite.py` builds a SQLite DB from the fixtures with foreign keys and CHECKs on. It's
stdlib-only and useful as a reference schema, but this repo has its own database — don't
wire it into the app. Add `meira_db.sqlite` to `.gitignore` if you run it.

## Phase 4 — report

1. **The Phase 0 classification** — redundant / better-data / genuinely new, per area.
2. **Differential results** — where `resolveClashes` and the fixture disagree, and which is
   right.
3. **Real defects** — most severe first, with the failing input and file:line.
4. **Untestable** — anything with no seam to exercise it. This is the architecture feedback
   I most want.
5. **What you added** — paths and how to run them.

Three things the fixture deliberately does not model — **no venue opening hours, no concept
of "now", no movable meetings**. Check how the app handles each; proposing a dentist at
19:30 or a slot in the past are live bugs if nothing guards them.

Work on a branch, not the default branch.
