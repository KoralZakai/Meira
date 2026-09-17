"""Departure reminders: the app owns them, so the server does not ping too.

The reported bug was "notifications appear 3 times". One planned trip produced
three pings on the same phone at the same minute: the mobile app's own local
alert (it plans wake / leave / "still at home?" from the same route), an Expo
push carrying this server's copy, and the WhatsApp message. These cover the
rule that decides which of them survives.
"""
import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import config
import reminders
from user_store import DatabaseService


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class DepartureOwnershipTests(unittest.TestCase):
    def setUp(self):
        self._flag = config.APP_OWNS_DEPARTURE_ALERTS
        config.APP_OWNS_DEPARTURE_ALERTS = True

    def tearDown(self):
        config.APP_OWNS_DEPARTURE_ALERTS = self._flag

    def _with(self, token, age_days):
        return (
            mock.patch.object(DatabaseService, "get_push_token_by_phone",
                              new=mock.AsyncMock(return_value=token)),
            mock.patch.object(DatabaseService, "push_token_age_days",
                              new=mock.AsyncMock(return_value=age_days)),
        )

    def test_live_app_owns_the_departure(self):
        a, b = self._with("ExponentPushToken[x]", 0.5)
        with a, b:
            self.assertTrue(_run(reminders._app_owns_departures("972500000000")))

    def test_no_token_means_the_server_still_delivers(self):
        a, b = self._with(None, None)
        with a, b:
            self.assertFalse(_run(reminders._app_owns_departures("972500000000")))

    def test_a_stale_token_is_not_a_live_app(self):
        """Uninstalled app, number still linked — silencing WhatsApp here would
        leave the trip with no reminder at all."""
        a, b = self._with("ExponentPushToken[x]", 40)
        with a, b:
            self.assertFalse(_run(reminders._app_owns_departures("972500000000")))

    def test_unknown_age_fails_open(self):
        """Tokens registered before push_token_at existed have no stamp."""
        a, b = self._with("ExponentPushToken[x]", None)
        with a, b:
            self.assertFalse(_run(reminders._app_owns_departures("972500000000")))

    def test_lookup_failure_fails_open(self):
        with mock.patch.object(DatabaseService, "get_push_token_by_phone",
                               new=mock.AsyncMock(side_effect=RuntimeError("db down"))):
            self.assertFalse(_run(reminders._app_owns_departures("972500000000")))

    def test_the_flag_turns_it_off(self):
        config.APP_OWNS_DEPARTURE_ALERTS = False
        a, b = self._with("ExponentPushToken[x]", 0.1)
        with a, b:
            self.assertFalse(_run(reminders._app_owns_departures("972500000000")))

    def test_departure_rows_are_tagged(self):
        """Untagged rows can't be recognised by the poller, so the tag is the fix."""
        tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).date().isoformat()
        with mock.patch.object(reminders, "_save") as save, \
             mock.patch.object(reminders, "_load", return_value=[]), \
             mock.patch.object(reminders.database_service, "shadow_write"):
            reminders.schedule_departures(
                "972500000000",
                [{"destination": "Space Gym", "date": tomorrow,
                  "wakeUpBy": "07:10", "leaveHomeBy": "08:05",
                  "arriveBy": "09:00", "travelMinutes": 40}],
                "he",
            )
            written = [row for call in save.call_args_list for row in call.args[0]]
        self.assertTrue(written, "nothing was scheduled")
        self.assertTrue(all(r.get("kind") == "departure" for r in written),
                        [r.get("kind") for r in written])


if __name__ == "__main__":
    unittest.main()
