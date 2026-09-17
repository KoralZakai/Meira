import os
import tempfile
import unittest
from datetime import date
from unittest.mock import patch

import user_memory


class UserMemoryDefaultDateTests(unittest.TestCase):
    def test_add_task_defaults_to_today_when_date_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.object(user_memory, "_PATH", os.path.join(tmpdir, "user_memory.json")):
                user_memory.add_task("+972-52-123-4567", {"text": "Test task", "category": "general"})
                tasks = user_memory.tasks_for_phone("972521234567")
                self.assertEqual(len(tasks), 1)
                self.assertEqual(tasks[0]["date"], date.today().isoformat())


if __name__ == "__main__":
    unittest.main()
