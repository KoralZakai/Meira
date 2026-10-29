# After a change — Meira offers one smart improvement (PLAN, 19.10)

> סיכום בעברית: כשמשהו ביום משתנה (ראיון נדחה, פגישה בוטלה, אירוע חדש נוחת על יום עמוס) מאירה
> (1) מבינה, (2) מבצעת, (3) בודקת את היומן בקוד, (4) מציעה **שיפור אחד** עם שאלה אחת, קצר.
> התשובה הקצרה של קורל ("כן", "ב-8", "בערב", "אחר כך") נשמרת לאמת — רק מה שבאמת נשמר נאמר.
> לעולם לא שואלים "איך תגיעי?" — זה `travelLadder`.

Status: **plan only.** Nothing here is built. Picks from Koral go in §9 before any code.

---

## 0. What exists, and where it falls short (read from the code, 19.10)

| Piece | What it does today | The gap this plan closes |
|---|---|---|
| `server/reschedule.py` + `agent_turn.reschedule_turn` | Deterministic voice/chat move ("to <day>"); reply = what moved + time gained + ONE question; `pending_offer` in `session.py` (20 min TTL); the answer books a 2 h `course` block the day before + a WhatsApp reminder | (a) only the "to <day>" shape — not "earlier", "cancelled", "an hour later"; (b) only interview/exam/class/course kinds; (c) **the offered hour is never checked against her day** (clash, evening kept clear, wake time) — step 3 of Koral's list ("check the calendar") is only a clash line about the *moved* task; (d) the question promises "ולהעיר אותך בבוקר" but `_book_study` books a reminder *at the study hour* — no morning wake-up exists → **a promise with nothing behind it** (silent-state rule 3); (e) `parse_answer`: "ב-8" is 08:00 even when the block is an evening; no "בערב / בבוקר / אחר צהריים"; "אחר כך" counts as *no* (it is *later*); (f) the study block is not linked to the interview — move the interview again and it stays |
| `GoogleSync` reconcile (`reconcileExternalTask` → `changed`, `before`) | Notices that Google/Outlook moved an event; re-arms alerts | **Says nothing to her.** An organiser moving an interview yields no suggestion at all. `before` is right there |
| `moveHeld.ts` | Her move survives the next import | Fine; the suggestion must be keyed so a re-import does not re-trigger it |
| `interviewPrep.ts` | Phone mints deep/review/morning prep blocks per interview, idempotent by id | Already follows an interview that moves (ids derive from it). The server-made "Study for…" block is a **second, unlinked** thing — two sources of prep (rule 8) |
| `free_slots.find`, `clashes.py`, `day_plan.py`, `dayFeasibility.ts`, `GapFillService` | All the facts, in code, no model | Not wired to a *change* |
| `src/questions/*`, `QuestionService`, `MeiraAskSheet` | Popup framework with limits, snooze, outbox, learning, nudges when app closed | New kind needed; the framework gives triggers 2–4 below for free |

## 1. Catalogue of changes → facts (code) → ranked suggestions

A **change** is `{task, before:{date,time,duration,travel}, after:{…}, source}` with `source ∈ {voice, chat, calendar_sync, manual_drag, route_recalc}`.
One pure function computes the **facts**; one pure function ranks **suggestions** from them. Neither calls a model.

Facts available per change (all exist or are one-liners over existing code):
`days_delta`, `minutes_delta` (same-day shift), `time_gained_for_prep` (days, from `reschedule._days_between`), `new_clashes` (`clashes.py`, with `kind`), `freed_window` (`free_slots.find`, old slot after removal), `day_status_after` (`dayFeasibility` / `day_plan`: OVERLAP > INFEASIBLE_TRAVEL > WAKE_CONFLICT > TIGHT > OK), `leave_by_after`, `wake_by_after` (`day_plan`), `prep_blocks_orphaned` (prep ids whose parent moved/vanished), `evening_before_clear` (`free_slots.EVE_FROM`), `is_past`.

| # | Change | Detect | Facts | Suggestions, ranked (max 2 shown, one question at a time) |
|---|---|---|---|---|
| 1 | **Prep-kind event moved LATER** (≥1 day) — Koral's Workday case | voice/chat `find_move`; sync: `changed ∋ date` and `after > before` | days gained; evening-before clear?; existing prep blocks | ① study block at a **proposed free hour** (the evening before, from `free_slots`) — one yes/hour/no; ② the morning-of: wake-up + "learn before leaving" (this is `interviewPrep` `morning` block, so it is *booked*, not just promised) |
| 2 | Prep-kind event moved EARLIER | same, `after < before` | days lost; `study_slot` = None when too close | ① "Study tonight at <free hour>?" (compress); ② if still impossible: **say so**, no question ("the interview is tomorrow — I put the deep block tonight at 20:00") |
| 3 | Same-day time shift (±≥15 min) | `changed ∋ fixedTime` | minutes delta; new leave/wake; new clash; tight | If a problem (clash / tight / wake conflict): ① top option from `clashes.py` ("move the 18:00 call to 19:15?"). Else a **statement, no question**: "Leaving 40 min later now: 11:20 ✓" |
| 4 | **Cancelled / deleted** | row gone from import / `status` moved-cancelled | freed window ≥ 60 min and not past; orphan prep/reminder/brief | ① drop the orphaned prep & reminders (do it, say it, Undo); ② fill the freed window with the best `GapFillService` idea (one) |
| 5 | **New event lands on a busy day** | `inserted` outcome | new clash / TIGHT / INFEASIBLE_TRAVEL / WAKE_CONFLICT | ① resolve the worst problem with `clashes.py` option that has a free target (`free_slots`); ② nothing else — no "improvement" on top of a problem |
| 6 | **Trip got longer** (route recalculated, ≥10 min worse) | `route_recalc`: `travelMinutes` up | leave/wake earlier; previous task now clashes | Statement ("leave 11:05, wake 06:30"); if the earlier task now collides: ① move/shorten it. **No vehicle question** — `travelLadder` re-decides, the card chips stay |
| 7 | **Deadline moved** | `deadline` changed | days delta; `latestStartBy`; estimatedWork | later: ① re-spread the work blocks; earlier & does not fit: ① say it and offer the one block to start today |
| 8 | Other kinds moved (dentist, gym) | `find_move` non-prep kind | clash only | statement of the new day; no improvement offered (today's behaviour, kept) |

**Ranking:** (1) problems before improvements — severity order is `dayFeasibility`'s; (2) improvements by value: prep (interview/exam) > freed window > nothing; (3) max **two** per change, and the second is only raised after the first was answered or declined (a separate turn / card), never two questions in one message.

**Suppression (so Meira does not nag):** past events never; hold 22:00–07:30 until the morning (phone alerts) ; one batch per *change key* `change:<taskId>:<afterDate>:<afterTime>`; a "no" is remembered for that key; three "no" to the same *kind* → stop offering it and say so once (the existing ask-and-learn rule proposal); a re-import of the same Google state never re-raises it (`moveHeld`).

## 2. Where shown, and what triggers it (rule 7)

The change itself enters from three doors; all of them write ONE record, a **ChangeRecord** (`key`, facts, ranked suggestions, `state: open|answered|declined|expired`) and the surfaces below read it.

| Door (who detects) | App open on Today | App open elsewhere | App closed | She went looking |
|---|---|---|---|---|
| **She says it** (mic / chat / WhatsApp → server `reschedule_turn`) | the reply in the chat + a Today card from the `moved` field of the reply | reply is in the chat she is in; AppState `active` shows the card | WhatsApp reply (existing); card waits | opening Today / the task shows the open card |
| **Calendar changed it** (phone: `GoogleSync` reconcile `before`→`after`) | card on Today (listener `onCalendarSync`, already present) | `MeiraAskSheet` kind `afterChange` via `QuestionService.maybeAsk` at the AppState-active root (`FocusLectureHost`-style, not a screen) | the WorkManager job (`CalendarAutoSync`, ~15 min floor) writes the record → **one** notification via `backgroundQuestions` (max 2 nudges per key, existing) | pull-to-refresh / picking the day force the sync (`force`) and show it |
| **Route recalculated** (`ensureTravelChain`) | statement line on the trip row (fact, not a question) | same | silent record; surfaces on next open | the trip row shows the new leave/wake without a tap (rule 5) |

A suggestion whose trigger row is empty is not shipped. The first increment covers door 1 fully and door 2 for "moved later / earlier" only.

**Where the record lives:** the engine is pure Python (`server/change_facts.py`, `server/change_suggest.py`); the phone posts `{before, after, the two days' rows}` to `POST /app/change/suggest` (calendar stays on the phone, like `/app/meeting/brief`), the server's own turn computes it directly. The phone keeps the answered/declined state in AsyncStorage, the server in the `pending_offer` slot (generalised, see §3). No TS twin of the logic → no parity test to drift. *(Alternative: TS twin + parity test like `clashes`; rejected — two implementations for something the server already needs for WhatsApp.)*

## 3. The follow-up dialogue

**Meira's message shape (always):** `done → what it gives → ONE question`, ≤ 2 sentences + question, EN and HE from the same template table (`reschedule.reply` grows into `change_say.py`).

> HE: "הזזתי את הראיון ב-Workday ליום שלישי 20.10 ✓ זה נותן לך עוד יום להתכונן! ללמוד היום ב-20:00?"  [כן] [שעה אחרת] [לא צריך]

The change from today: **Meira proposes a concrete free hour** (found by `free_slots`, evening before heavy day respected, not past) instead of "באיזו שעה?". A bare "כן" now suffices — the cheapest answer is the common one. "באיזו שעה?" is asked only when no free hour exists or she says "שעה אחרת".

**Answer grammar** (`parse_answer` v2, pure, bilingual, tolerant):

| She says | Meaning | Result |
|---|---|---|
| כן / בטח / יאללה / yes | accept the proposed hour | book |
| 8 / ב-8 / בשמונה / 20:00 / 8pm | an hour; **period resolved by the block's kind** (study the evening before → 20:00; "morning-of" block → 08:00), explicit "בבוקר/בערב/אחה״צ/am/pm" wins | book |
| בערב / בבוקר / אחר הצהריים | a day-part → Meira picks the free hour inside it and **says which** | book |
| שעה אחרת / מתי יש לי פנוי? | show the free windows as chips (one question) | re-ask |
| אחר כך / later / תזכירי לי | **later** — keeps the card, snoozes (not "no") | snooze |
| לא / לא צריך / no | decline this key | clear |
| a long message / unrelated | not an answer — new request; the offer stays until its TTL | pass through |

**What is booked** (each a separate saved thing; the reply names only those that returned success — no fake confirmations):
1. the study block in the diary (`persist_agent_tasks` result `saved` non-empty), `course`, linked to the interview by `parent_id` so a second move carries it along;
2. the reminder at the block's hour (`reminders.schedule` truthy);
3. if she accepted the "wake me" part: a **wake alarm** on the phone (the existing `plannedAlarmTime` derivation from a `fixedTime` morning block) — **until that exists server-side the reply must not say "ואעיר אותך בבוקר"**; today's text does.

One sentence back, built from what saved: `הוספתי ליומן "לימוד לקראת הראיון ב-Workday" · יום שני 19.10 ב-20:00 ✓ 🔔` — if the reminder failed: the same line without 🔔; if the diary failed: "לא הצלחתי לשמור 🙈" and the offer **stays** open (today it is also kept, good).

Pending offer v2 (`session.py`): `{kind, change_key, task_id, proposed:{date,time}, slots_needed:[…], he, at}`; TTL 20 min in chat, but the *card* on the phone lives until the event is past. A one-question-at-a-time queue: the second suggestion is stored `queued` and promoted when the first resolves.

## 4. Speech (the mic mishears)

Real case: "הראיון" → "העיון", "נדחה" → "נתחל". `find_move` already tolerates it (task found by names, interview by sound ≥ 0.6, day by the "to <day>" shape). To go further:

- **Evidence over exactness:** a move needs (a) a *destination* shape (`ל<יום>`, `למחר`, `ל-22.10`, `to <day>`, **new: "ב<שעה> במקום <שעה>", "שעה יותר מאוחר/מוקדם", "הוקדם/התבטל/בוטל"**) and (b) *one task by evidence* (names, kind-by-sound, old day). When the evidence is thin → **ask which**, with the 2 candidates as chips — never guess, never "נתקעתי".
- **Phonetic confusions table** (`reschedule._SOUNDS`): ר/ע, ח/כ, ת/ד, א/ע — apply on verb match too, so `נתחל`→`נדחה` is matched as a move verb, not only rescued by the day shape.
- **STT hint list:** the app already sends place corrections; add the user's **task names and company names of the next 7 days** as recognition hints (`expo-speech-recognition` `contextualStrings`) — "Workday" arrives spelled right.
- **TTS (SHORT):** the spoken line is only `done + gain` ("הזזתי את הראיון ליום שלישי ✓ יש לך עוד יום להתכונן"); the question is **shown** as chips, spoken as the last clause only when the screen is not visible. he-IL / en-US from the language of the *message*, same as today's `he` flag.
- **Echo the interpretation** when confidence is below "exact": "הבנתי: הראיון ב-Workday → שלישי. נכון?" costs one tap and replaces a silent wrong move (only when the match came via the sound table or a 1-score).

## 5. Evaluation and tests

New tests (**would FAIL on today's behaviour**, marked ⛔):

`server/tests/test_change_facts.py`
- ⛔ later move gives `days_gained`, evening-before clear flag, prep ids
- ⛔ earlier move too close → no study slot, fact says so
- same-day +40 min → new leave/wake; clash → top option; tight
- cancelled → freed window, orphans listed
- new event on busy day → worst problem first, no "improvement" on a problem
- trip longer → leave/wake, **no suggestion has kind `trip_mode`** (hard rule from Koral 19.10: asserted by walking every template)

`server/tests/test_change_suggest.py`
- ranking: problem > prep > freed window; max 2; second is `queued`
- ⛔ the proposed hour is never in the past, never inside another task (+buffer), never after `EVE_FROM` on the evening before a heavy day
- ⛔ the question text never contains a wake-up promise unless a wake alarm is among the actions
- suppression: past, quiet hours, same key twice, 3× decline

`server/tests/test_reschedule.py` (extend)
- ⛔ `parse_answer("ב-8")` for an evening block → 20:00; "בערב" → day-part; "אחר כך" → `later`, not `no`
- ⛔ `reply()` for a prep kind carries a concrete proposed hour; "באיזו שעה?" only when none is free
- ⛔ garbled sentences: "העיון … נתחל" (kept), plus 6 new ones (verb mangled, name mangled, no verb, English mixed)
- booking: diary fails → offer kept & no ✓; reminder fails → line without 🔔; study block has `parent_id`

`server/evals` — new dataset `changes.jsonl` (≥ 30 rows, HE+EN, 10 garbled): `{utterance, tasks, expect:{task_id,new_date,new_time|kind}}`; metrics: **accuracy ≥ 0.9, wrong-task-moved = 0** (a wrong move is the only unforgivable error), hallucinated-promise = 0 (reply claims something no action backs). Offline run is code only (no model), so it gates CI like the existing logic gates.

Phone (`tests/run-change-record.ts`, added to `test:all`): reconcile `before→after` becomes a ChangeRecord with the right key; a re-import of the unchanged Google state does **not** re-raise it (`moveHeld`); the sheet text for `afterChange` has HE/EN parity (`npm run test:langparity`); background run nudges at most twice per key.

Whole suite before any commit: `npm run test:all`; `server/.venv/bin/python -m pytest server/tests`; `python -m evals --offline` (venv lives in the main checkout: `/Users/user/dev/Lumi-My-AI-Assistant/server/.venv/bin/python`).

## 6. Increments (small, each shippable and tested)

1. **Honest, checked offer (server only).** `change_facts.py` (later/earlier kinds only) + proposed free hour via `free_slots` + `parse_answer` v2 (day-parts, `later`, period by kind) + remove the unbacked wake promise / or book it. Covers Koral's Workday sentence end to end. *← first thing to build after picks.*
2. Link the study block to its interview (`parent_id`) and follow a second move.
3. Cancelled + same-day shift + new-event-on-busy-day facts and the problem-first ranking (server turn).
4. Phone door: reconcile `before→after` → ChangeRecord → `afterChange` question kind + Today card (picks from §9).
5. Background: nudge from the WorkManager job; quiet hours.
6. Speech: contextual strings, phonetic table, echo-the-interpretation.
7. Deadline moved; trip longer statement.

## 7. Hard rules carried over

- **No travel question, ever.** A suggestion template list is asserted in a test to contain no `how will you get there` / `איך תגיעי` / `trip_mode`. The way is `travelLadder`'s; the chips on the card change it, instantly.
- Short: ≤ 2 sentences + 1 question. Both languages from one table. Nothing said that did not save.
- Time and date of the suggested block are always on screen (rule 4); a suggestion that failed to book says so (rule 3).
- No secrets printed; no prod ssh; local commit only, **push to master is Koral's**.

## 8. Open questions (decide with Koral)

1. Should "wake me in the morning" be a real alarm booked by Meira (needs the phone, so only after the next sync) or dropped from the offer? *Recommended:* real alarm via the `morning` prep block, and the sentence says "אעיר אותך ב-06:40" with the real hour.
2. Quiet hours for suggestions from the phone door (22:00–07:30 proposed).
3. Does "no" three times switch the kind off, or only ask?

## 9. Koral's picks (19.10)

- **Screens 1–4: option A everywhere** (one proposed hour + chips; card on Today; one-line confirm + Undo; second suggestion on the next turn).
- **Free window → fill it.** The proposed hour comes from her free windows (`propose_study`), not a fixed hour. Day-part answers ("בערב") pick inside the free windows and say the hour.
- **Morning: flexible hours, not a fixed 06:40** — `morning_options` offers 7 / 8 / 9 (as many as still leave the trip + getting ready); none if the event is too early.
- **How pushy Meira is — her choice** (`profile.nudgeLevel`): `alarm` = one plain reminder at the hour, no cheering; `gentle` (default) = a heads-up 30 min before + the reminder; `motivating` = a cheer an hour before, the reminder, a check-in after. Server side done (`nudges_for`, `normalize_level`, read in `_nudge_level`). **Setting in Profile: pick "2" — three radio cards, each with a sample of what she gets (built 19.10, `ProfileEditScreen`, `utils/nudgeLevel.ts`; names: שעון בלבד / עדין / מעודד).** It reaches the server with the next chat turn (`LumiBrain.profileForBrain` → `agent_turn._APP_PROFILE_FIELDS`); unset = `gentle`.

- **Cancelled events (built 19.10):** found a pre-existing silent bug — Google stops listing a cancelled event but the importer only adds/corrects, so the appointment stayed on her day (with route, alarm, prep) for ever. Now `utils/cancelledEvents` + `GoogleSync.noteCancellations`: gone from TWO syncs of the same day, only when Google answered for every account, never a row she moved, reset when the set of accounts changes; then a card: "בוטל ביומן · פנוי 15:00–16:30 · יש 2 הכנות שלו" → [הסר (גם את ההכנות)] [להשאיר]; after removal, the best `GapFillService` idea for the freed window. Nothing removed without her yes. **All three calendars (20.10):** Google reads a day at a time, the phone's own calendars (`dcal-`) and Outlook (`ocal-`) a month in one go; each judges only its own rows, only after its read fully succeeded, and restarts its count when the set of accounts/calendars changes.

## 10. Built so far (local commit, not pushed)

Increment 1, server only: `reschedule.propose_study / morning_options / parse_answer v2 / pick_in_part / free_starts / nudges_for`, `agent_turn._answer_offer / _book_study / _book_morning`; the "wake you in the morning" promise is gone from the first question and only said (🔔, "אעיר אותך ב-08:00") when a reminder really saved. Tests: `tests/test_reschedule.py` (+21), `tests/test_reschedule_flow.py` (10, end to end incl. failures). **App closed (built 19.10):** `CalendarAutoSync` WorkManager job → `ChangeNudgeService` → one notification per run about the soonest unseen change (`utils/changeNudge`): quiet hours 22:00–07:30 held not dropped, at most 2 per change with ≥3 h between, never for a card she saw/answered/closed, not while the app is in front; tap opens Today. Not yet: cancelled-event cards, a unit test of ChangeRecordStore dedupe/close (needs an AsyncStorage mock), linking the study block to its interview (increment 2), the morning block still a WhatsApp reminder (the phone's own `morning` prep block is the diary entry — no twin).
