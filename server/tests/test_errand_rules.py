"""1.10: "לתקן את מכונת הקפה" came back "not an errand" from the model."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import errands_along as e  # noqa: E402


def test_the_errands_any_city_has_a_shop_for():
    assert e.rule_understand("לתקן את מכונת הקפה")["query_he"] == "תיקון מכונת הקפה"
    assert e.rule_understand("fix my coffee machine")["query_en"] == "coffee machine repair"
    assert e.rule_understand("fix my coffee machine")["query_he"] == ""
    assert e.rule_understand("לאסוף חבילה מהדואר")["query_he"] == "דואר ישראל"
    assert e.rule_understand("לקנות מתנה לניקיטה")["query_he"] == "חנות מתנות"


def test_not_every_to_do_is_an_errand():
    for t in ("לכתוב את הדוח", "ללמוד לראיון", "call mom"):
        assert e.rule_understand(t) is None, t
