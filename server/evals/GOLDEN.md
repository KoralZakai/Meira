# Golden dataset — what Meira and the app must do

`datasets/golden.jsonl` is the agreed behaviour: a user request (or a sequence of
them) and the expected reaction, both in the chat and in the app. Koral signs off
each case; a case is ground truth only once its `status` is `approved`.

## One case

```json
{"id": "g035", "area": "sequence", "origin": "bug 20.10 #4", "status": "approved",
 "given": {"now": "Thu 10:00", "tasks": ["Fri 09:00 gym"], "profile": "no car"},
 "turns": [
   {"user": "פגישה עם נועה ב-10", "meira": "Saves tomorrow 10:00.", "say": "✓ מחר 10:00 עם נועה", "app": "Card tomorrow."},
   {"user": "לא, ביום שלישי", "meira": "Moves THAT task to Tue 10:00.", "say": "✓ הועבר לשלישי 10:00", "app": "Card moves."}],
 "must_not": "Treat 'ביום שלישי' as chat; make a new task."}
```

| Field | Meaning |
|---|---|
| `given` | The world before turn 1: `now`, existing `tasks`, `profile`, `where` (GPS), `outside` (a provider failing), `quota`, `calendar`, `news` |
| `turns[].user` | What she says. `(…)` in parentheses = a non-chat trigger (a tap, a sync, time passing) |
| `turns[].meira` | What Meira DOES — saves, moves, asks, refuses. This is what gets checked |
| `turns[].say` | An example reply. Tone and length guide; the exact words are not checked |
| `turns[].app` | What the phone shows after the turn |
| `must_not` | The wrong reaction we have seen or fear. One hit = fail |
| `status` | `draft` → `approved` (she said ✓) or `rejected` (case is wrong; kept so it is not re-proposed) |
| `koral` | Her own words for the expected result, kept verbatim — the source of truth when `meira`/`app` are unclear |
| `origin` | `spec`, or `bug <date> <short name>` for a case born from a bug |

Review page: https://claude.ai/artifact/MUJWHT43vn8qLx5hNdTrBM (verdicts in its `verdicts` collection).

## Her standing rules (from her answers)

- **Missing details never block a save — they make the task an ALERT.** A task with no place, no exact date or time, or (for a meeting) no contact is saved at once, marked *alert*, and listed in the alerts list of tasks to handle (like Facebook notifications), with options where Meira can find them (contacts, nearby branches). On the task's morning, if still incomplete, Meira asks again. An online meeting needs no place.
- **A person's name → search contacts** in Hebrew and English; several matches → she picks; never guess.
- **The last correction wins.**
- **A trip is planned only once the place is known**, from where she will be (the previous task), by her usual mode.
- **Free time between tasks → a suggestion** for using it.
- **An interview → prep on the 3 days before**, and the night before the wake time is re-checked from where she is.

## The rule: every fixed bug becomes a golden case

When a bug in a reaction (chat or app) is fixed:

1. Add a case to `golden.jsonl` with `origin: "bug <date> <name>"`, the real sentence(s) she used,
   and the wrong reaction in `must_not`.
2. Status `approved` only if she already said what the right reaction is; otherwise `draft`, and
   ask her.
3. Where the reaction is code (dates, intents, categories, clashes, lookups), also add the row to
   the offline dataset it belongs to, so CI catches a regression for free.

`tests/test_golden_dataset.py` keeps the file well-formed.
