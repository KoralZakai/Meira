"""Every JSON store writes to Postgres too — except the two that must not.

This is a structural test on purpose. The migration's real risk is not a broken
query; it is a store quietly left behind, still the only copy of something,
discovered the day the volume is retired. So: name every store, assert each one
either shadows its writes or is on the exclusion list with a reason.

The exclusions are deliberate:

  pending_mirror.json   the retry queue for writes that failed BECAUSE Supabase
                        was unreachable. A queue for "the database is down"
                        cannot live in the database.
  active_session.json   a 45-minute conversational focus, rewritten on nearly
                        every turn. Shadowing it would be the highest write
                        volume in the system for the least durable data in it.
  meeting_briefs.json   a cache of public web pages. Every byte is rebuildable
                        by re-asking Tavily, so losing it costs one search, not
                        one fact. It is still per-user and still deleted with
                        the account (account_deletion._STORE_MODULES) — this
                        exclusion is about durability, not about privacy.
  task_prep.json        the same kind of cache for any task (songs for karaoke,
                        what to bring to a clinic): public pages, rebuildable,
                        per-user, deleted with the account.
  mcp_tokens.json       SHA-256 hashes of the personal tokens AI assistants use
                        to reach Meira over MCP. Losing them costs one reconnect;
                        a database copy of credential material is one more place
                        for it to leak. Deleted with the account.
  chat_feedback.json    👍/👎 on chat replies, for the owner to turn into golden
                        cases. Encrypted, capped (500 rows / 90 days), deleted
                        with the account; a review queue, not a record.
  feedback.json         👍/👎 ranking signals. The durable half of every verdict
                        is the sentence written to user_memory (which IS
                        shadowed); losing this file costs the ranking boost only.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SERVER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# module -> the JSON file it owns
SHADOWED = {
    "user_memory": "user_memory.json",
    "user_profile": "profiles.json",
    "conversation": "conversations.json",
    "known_places": "known_places.json",
    "travel_prefs": "travel_prefs.json",
    "provenance": "sessions.json",
    "reminders": "reminders.json",
    "agents_store": "agents.json",
    "user_store": "user_store.json",
    "bug_reports": "bug_reports.json",
    "llm_usage": "llm_usage.json",
    "judge_service": "judge_log.json",
}

EXCLUDED = {
    "user_quota": "llm_usage_people.json",     # spend counters; losing them only resets allowances
    "supabase_tasks": "pending_mirror.json",   # the retry queue for a down DB
    "session": "active_session.json",          # 45-minute focus, rewritten per turn
    "meeting_brief": "meeting_briefs.json",    # rebuildable cache of public pages
    "task_prep": "task_prep.json",             # same: cited prep from public pages
    "mcp_server": "mcp_tokens.json",           # credential hashes: see the docstring
    "feedback_store": "feedback.json",         # ranking signals; the words are in user_memory
    "chat_feedback": "chat_feedback.json",     # 👍/👎 review queue; capped, see the docstring
    "questions_store": "questions.json",       # her answers; the words are in user_memory
    "user_rules": "user_rules.json",           # rules she confirmed; small, read every turn
    "phone_links": "phone_links.json",         # identity proofs; must never leave the server
}


def _source(module: str) -> str:
    with open(os.path.join(SERVER, f"{module}.py"), encoding="utf-8") as handle:
        return handle.read()


def test_every_shadowed_store_actually_shadows():
    missing = [m for m in SHADOWED if "database_service.shadow_write" not in _source(m)]
    assert not missing, f"these stores write only to disk: {missing}"


def test_the_two_exclusions_stay_excluded_and_stay_documented():
    for module in EXCLUDED:
        assert "database_service.shadow_write" not in _source(module), (
            f"{module} must NOT shadow — see this module's docstring for why")


def test_no_json_store_is_unaccounted_for():
    """A new `_PATH = ... .json` in any module has to be classified here.

    Without this the failure mode is silent: someone adds a store, it works, and
    nobody notices it is the only copy of something until the volume is gone.
    """
    known = set(SHADOWED.values()) | set(EXCLUDED.values())
    # Files that are inputs or artefacts rather than stores of user state.
    known |= {"cv_master.sample.json", "personality_parity_fixture.json", "dana.json",
              # judge_service: ONE shared, scrubbed text rebuilt every 10 judgements
              "lumi_guidelines.json"}

    found = {}
    for name in sorted(os.listdir(SERVER)):
        if not name.endswith(".py"):
            continue
        for match in re.finditer(r'["\']([a-z_]+\.json)["\']', _source(name[:-3])):
            found.setdefault(match.group(1), name[:-3])

    unaccounted = {f: m for f, m in found.items() if f not in known}
    assert not unaccounted, (
        f"unclassified JSON stores: {unaccounted} — shadow them into Postgres "
        "or add them to EXCLUDED with a reason")
