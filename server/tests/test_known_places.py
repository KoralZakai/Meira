"""Write the address once; the activity name finds it forever after.

Koral's requirement, in her words:

    enough for me to write once "yoga class" / "אימון בחדר כושר" in יגאל אלון 94
    next time "yoga class on 11:00" automatically location known and bike

So the three things that must hold: the address is learned from ONE message,
it is found again from a DIFFERENT wording, and it is found across languages.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

import known_places as kp


class ConceptTests(unittest.TestCase):
    def test_her_three_wordings_are_one_activity(self):
        keys = {kp.activity_key(t) for t in
                ["yoga class", "אימון בחדר כושר", "יוגה בערב", "workout", "training"]}
        self.assertEqual(len(keys), 1, f"expected one key, got {keys}")

    def test_a_generic_container_never_beats_the_activity(self):
        # "class" is longer than "yoga"; without the generic demotion this
        # resolved as @class and a yoga session landed at the last course.
        self.assertEqual(kp.activity_key("yoga class"), "@fitness")
        self.assertEqual(kp.activity_key("שיעור יוגה"), "@fitness")

    def test_an_unrelated_class_is_still_a_class(self):
        """Still keyed under the container concept — but NOT merged with every
        other lesson.

        This asserted a bare "@class" until 2026-09-17, which meant every
        lesson this table has no concept for shared ONE key and therefore one
        address: "חוג קרמיקה של נועה" and "שיעור גיטרה" both resolved to
        whichever was saved last. That is precisely the "wrong merge sends her
        to the wrong address" this module's own comment warns about, and it
        lived in the fallback branch — which is most hobbies.

        Found while porting this rule to the phone (src/utils/knownPlaces.ts);
        the two implementations are kept in step by
        tests/run-known-places.ts.
        """
        self.assertTrue(kp.activity_key("שיעור אנגלית").startswith("@class"))
        self.assertNotEqual(kp.activity_key("שיעור אנגלית"),
                            kp.activity_key("שיעור גיטרה"))
        self.assertNotEqual(kp.activity_key("חוג קרמיקה של נועה"),
                            kp.activity_key("שיעור גיטרה"))

    def test_a_real_activity_is_still_shared_on_purpose(self):
        """The qualification above must not fragment what SHOULD be one place.
        gym/yoga/workout are one key by design — her brief says so."""
        self.assertEqual(kp.activity_key("יוגה בערב"), kp.activity_key("gym"))
        self.assertEqual(kp.activity_key("שיעור יוגה"), "@fitness")

    def test_different_activities_stay_apart(self):
        self.assertNotEqual(kp.activity_key("בריכה"), kp.activity_key("חדר כושר"))
        self.assertNotEqual(kp.activity_key("רופא שיניים"), kp.activity_key("עבודה"))

    def test_word_order_does_not_fork_an_unknown_activity(self):
        self.assertEqual(kp.activity_key("שיחה עם גיא"), kp.activity_key("גיא שיחה עם"))

    def test_a_time_in_the_name_is_not_part_of_the_identity(self):
        self.assertEqual(kp.activity_key("yoga class 11:00"), kp.activity_key("yoga class"))


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._p = patch.object(kp, "_PATH", os.path.join(self._tmp.name, "known_places.json"))
        self._p.start()

    def tearDown(self):
        self._p.stop()
        self._tmp.cleanup()

    PHONE = "972500000009"

    def test_the_exact_scenario_she_described(self):
        # Written once, in Hebrew, with an address…
        kp.remember(self.PHONE, "אימון בחדר כושר", "יגאל אלון 94", 32.07, 34.79)
        # …found again from the English name, with no address at all.
        got = kp.resolve(self.PHONE, "yoga class")
        self.assertIsNotNone(got, "yoga class must find what אימון saved")
        self.assertEqual(got["address"], "יגאל אלון 94")
        self.assertAlmostEqual(got["lat"], 32.07)

    def test_nothing_learned_means_no_guess(self):
        self.assertIsNone(kp.resolve(self.PHONE, "yoga class"))

    def test_an_unrelated_activity_does_not_borrow_the_address(self):
        kp.remember(self.PHONE, "אימון בחדר כושר", "יגאל אלון 94")
        self.assertIsNone(kp.resolve(self.PHONE, "פגישה עם עורך דין"))

    def test_a_newer_address_replaces_the_old_one(self):
        # She changed gyms; the latest thing she said is the truth.
        kp.remember(self.PHONE, "חדר כושר", "יגאל אלון 94")
        kp.remember(self.PHONE, "חדר כושר", "הרצל 10")
        self.assertEqual(kp.resolve(self.PHONE, "workout")["address"], "הרצל 10")

    def test_same_language_variants_match_by_overlap(self):
        # No concept covers this one — word overlap has to carry it.
        kp.remember(self.PHONE, "שיחה עם גיא זוהר", "רוטשילד 1")
        got = kp.resolve(self.PHONE, "שיחה עם גיא")
        self.assertIsNotNone(got)
        self.assertEqual(got["address"], "רוטשילד 1")

    def test_another_persons_places_never_leak(self):
        kp.remember(self.PHONE, "אימון בחדר כושר", "יגאל אלון 94")
        self.assertIsNone(kp.resolve("972501234567", "yoga class"))

    def test_local_and_international_phone_are_one_person(self):
        kp.remember("0500000009", "אימון בחדר כושר", "יגאל אלון 94")
        self.assertEqual(kp.resolve("972500000009", "yoga class")["address"], "יגאל אלון 94")

    def test_a_blank_address_is_not_learned(self):
        kp.remember(self.PHONE, "yoga class", "")
        self.assertIsNone(kp.resolve(self.PHONE, "yoga class"))

    def test_a_corrupt_store_does_not_crash_the_route(self):
        with open(kp._PATH, "w", encoding="utf-8") as f:
            f.write("{ not json")
        self.assertIsNone(kp.resolve(self.PHONE, "yoga class"))

    def test_the_recall_is_always_stated(self):
        self.assertIn("יגאל אלון 94", kp.recall_line("יגאל אלון 94", "he"))
        self.assertIn("יגאל אלון 94", kp.recall_line("יגאל אלון 94", "en"))


if __name__ == "__main__":
    unittest.main()
