import unittest

from user_store import _normalize_phone


class PhoneNormalizationTests(unittest.TestCase):
    def test_strips_non_digits_and_leading_plus(self):
        self.assertEqual(_normalize_phone('+972-52-123-4567'), '972521234567')
        self.assertEqual(_normalize_phone(' +1 (555) 123-4567 '), '15551234567')


if __name__ == '__main__':
    unittest.main()
