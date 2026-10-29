# 21.10 — "I renamed the appointment many times and nothing changed"

**What she saw.** Tomorrow's appointment was titled "תור להקפאת ביציות באסף הרופא ב10:30". She changed it to
"תור לרופא…" in the app, many times, and then in Google Calendar. Meira's task never changed.

**Why (the root cause).** `user_memory.add_task`, the server's mirror, has a rule written for the chat:
*"a re-mention must not wipe details a fuller earlier mention set — the more detailed text wins"*:

    if prev.get("text") and len(prev["text"]) > len(text):
        text = prev["text"]

The app pushes the WHOLE task to `POST /tasks/{phone}` on every edit, and that goes through the same function.
"תור לרופא…" is **shorter** than the old title, so the old title won — in the mirror, and then
`_mirror_task_to_supabase` wrote it to the cloud. Every shortening edit was undone within a second, silently,
and the same line did the same to category 'general', priority 'need_to' and duration 30 (they were "defaults",
so the stored value won). The phone then pulled the cloud (cloud-first read) and showed the old title.

**Why it hid for so long.** Nothing failed: the push returned 200, the row was valid, Supabase accepted it.
A rule that is right for one door (a chat sentence) was shared with another door (the app's own edit), where the
same fact — "she typed this" — means the opposite. This is the *two readers of one blob* shape (CLAUDE.md rule 8),
on the write side: one writer, two meanings.

**The fix.** `trust_status=True` (the app's own push) already meant "this is the user's last decision". The longer-text
rule and the defaults-defer rules now apply only when it is false. `server/tests/test_reschedule.py::AppEditMayShortenTests`.

**What to look for next time (the lesson).**
1. A server-side *merge* on a path the user edits through is a place where an edit can be un-done. Ask of every
   "keep the better of old and new" rule: who calls this, and does the caller's word beat the stored one?
2. When an edit "does not take", compare the cloud row's `updatedAt` with the moment of the edit: a write that lands
   AND is reverted shows as a newer `updatedAt` with the OLD value.
3. A fix is not done until the old value does not come back after a sync — check twice, a minute apart.

**Golden set.** `server/evals/datasets/regressions.jsonl` r01 (app edit may shorten) and r02 (a chat re-mention may
not) keep both sides of the rule pinned (`accuracy.regression`, ratcheted at 100%).
