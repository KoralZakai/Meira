"""A cancel that did not happen may not be confirmed.

Live eval 20.10: "תבטלי את האימון של מחר" with no workout on her day →
"בטל ✓ אימון מחר 21.10". The save guard knew נשמר/עודכן/הוספתי, not בוטל.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lumi_agent import is_save_claim, strip_unbacked_save_claims  # noqa: E402


def test_the_reply_that_got_through_is_stripped():
    out = strip_unbacked_save_claims("בטל ✓ אימון מחר 21.10 (יום רביעי)", [], True)
    assert "בטל ✓" not in out and "⚠️" in out


def test_cancel_and_delete_claims():
    for line in ("ביטלתי את האימון", "האימון בוטל", "מחקתי את המשימה", "✓ נמחקה",
                 "I cancelled your workout", "Deleted!", "✓ Cancelled: gym"):
        assert is_save_claim(line), line


def test_asking_to_cancel_is_not_a_claim():
    for line in ("לבטל את האימון?", "רוצה שאבטל?", "לא מצאתי אימון לבטל",
                 "Want me to cancel it?", "Nothing was cancelled", "לא בוטל כלום"):
        assert not is_save_claim(line), line
