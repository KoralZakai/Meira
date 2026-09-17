"""The system prompt has to start with the part that never changes.

Providers cache a prompt by its longest stable PREFIX. This one used to open
with the clock ("time now 21:47"), the user's name and today's date, so the
~18KB of rules behind them missed the cache on every single message — the
prompt was resent and re-processed in full, per turn, per user, forever.

The fix is only an ordering, which is exactly the kind of thing that gets
undone by someone adding one friendly f-string at the top. These tests fail
when that happens:

  * the prefix is byte-identical for two different users, in two languages
  * nothing user-specific has leaked into it
  * it is still most of the prompt

The blocks that broke it were not in _system_prompt at all: the memory block
and the judge guidelines were prepended by handle_whatsapp_message to the
finished string, so these tests passed while production missed the cache on
every turn. They are now parameters of _system_prompt, and the tests below pass
them — a fragment nobody sends is not worth pinning.

No network: _system_prompt is pure string building.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lumi_agent  # noqa: E402

KORAL = ({"name": "Koral", "language": "he", "mbti_confidence": 0.6},
         {"name": "Koral", "homeAddress": "יגאל אלון 94", "transportType": "bus",
          "morningRoutineMinutes": 30, "hobbies": "programming", "language": "he"})
SOMEONE = ({"name": "Dana", "language": "en", "mbti_confidence": 0.9},
           {"name": "Dana", "homeAddress": "Rothschild 1", "transportType": "car",
            "morningRoutineMinutes": 55, "language": "en"})


#: What the two formerly-prepended blocks look like in real life.
MEMORY = "Routines: wakes at 07:30 | home by 19:00\nPreferences: 3h study blocks"
GUIDELINES = ("JUDGE FEEDBACK (last 10 evals, avg score 4.2/5):\n"
              "Apply these improvements to your responses:\n- Be shorter in Hebrew")


def _prompt(pair, missing=None, memory=None, guidelines=None):
    user, profile = pair
    return lumi_agent._system_prompt(user, None, profile, missing or [],
                                     memory_block=memory, guidelines=guidelines)


def test_two_different_users_share_the_whole_static_prefix():
    n = lumi_agent.STATIC_PROMPT_CHARS
    assert _prompt(KORAL)[:n] == _prompt(SOMEONE)[:n], (
        "the cacheable prefix differs between users — something per-user moved "
        "back to the top of the prompt")


def test_the_prefix_survives_a_different_onboarding_state():
    n = lumi_agent.STATIC_PROMPT_CHARS
    assert _prompt(KORAL, missing=["homeAddress", "sleepTime"])[:n] == _prompt(KORAL)[:n]


def test_nothing_user_specific_leaked_into_the_static_block():
    """Names, addresses and — the one that actually breaks caching — a rendered
    clock or date. The rules DO mention the phrase "time now" while telling the
    model which line to trust, so the test looks for a real reading (`time now
    21:47`) rather than the words."""
    import re
    rules = lumi_agent._STATIC_RULES
    for leak in ("Koral", "Dana", "יגאל אלון", "Rothschild", "Tomorrow (מחר) ="):
        assert leak not in rules, f"{leak!r} is in the cacheable block — it will never cache"
    for pattern in (r"time now \d{1,2}:\d{2}", r"Today: \d{4}-\d{2}-\d{2}", r"User: \w"):
        assert not re.search(pattern, rules), (
            f"{pattern!r} matched inside the cacheable block — a per-turn value "
            f"moved back to the top and the cache is dead again")


def test_the_cacheable_part_is_most_of_the_prompt():
    prompt = _prompt(KORAL)
    share = lumi_agent.STATIC_PROMPT_CHARS / len(prompt)
    assert share > 0.85, (
        f"only {share:.0%} of the prompt is cacheable; it was ~92% when this was "
        f"written, so something large and variable has been added")


def test_the_prompt_still_opens_and_closes_where_it_should():
    prompt = _prompt(KORAL)
    assert prompt.startswith("You are Lumi"), "the prompt must open with the identity line"
    # The language lock and the personality sit closest to the user's message,
    # which is where an instruction is followed best.
    assert prompt.rstrip().endswith("No other language."), "the language reminder must be last"
    assert "LANGUAGE RULE — ABSOLUTE" in prompt


def test_memory_and_guidelines_do_not_break_the_prefix():
    """THE regression this file exists for. Both of these used to be pasted in
    FRONT of the rules, so the cacheable prefix was whatever the retrieval
    happened to return for that message — i.e. never the same twice."""
    n = lumi_agent.STATIC_PROMPT_CHARS
    bare = _prompt(KORAL)[:n]
    assert _prompt(KORAL, memory=MEMORY)[:n] == bare, (
        "the memory block moved the static rules off the front of the prompt")
    assert _prompt(KORAL, guidelines=GUIDELINES)[:n] == bare, (
        "the judge guidelines moved the static rules off the front of the prompt")
    assert _prompt(KORAL, memory=MEMORY, guidelines=GUIDELINES)[:n] == bare
    assert _prompt(SOMEONE, memory="something else entirely")[:n] == bare, (
        "two users with different memories must still share the whole prefix")


def test_memory_and_guidelines_are_still_actually_in_the_prompt():
    """Moving them must not quietly drop them — the model still has to read
    both, just later."""
    prompt = _prompt(KORAL, memory=MEMORY, guidelines=GUIDELINES)
    assert "WHAT I KNOW ABOUT YOU:" in prompt
    assert "wakes at 07:30" in prompt
    assert "JUDGE FEEDBACK" in prompt
    assert prompt.rstrip().endswith("No other language."), (
        "the language reminder must still be the last thing the model reads")


def test_the_prompt_is_assembled_in_one_place():
    """No caller may concatenate onto the finished prompt — that is exactly how
    the prefix was lost. handle_whatsapp_message must pass the blocks IN."""
    import inspect
    src = inspect.getsource(lumi_agent.handle_whatsapp_message)
    assert "memory_block=" in src and "guidelines=" in src
    for bad in ('f"WHAT I KNOW ABOUT YOU:', '{guidelines}\\n\\n{base_prompt}'):
        assert bad not in src, f"{bad} — a block is being prepended again"
