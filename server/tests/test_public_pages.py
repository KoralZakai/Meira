"""The server's public URLs point at the one privacy policy, on the website.

Google's consent screen links to lumi-whatsapp.fly.dev/ and /privacy. If these
stop redirecting, Google shows users a dead link — or worse, a second policy
that has drifted from the real one.
"""
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

import public_pages


class PublicPagesRedirect(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(public_pages.router)
        self.client = TestClient(app)

    def _to(self, path):
        res = self.client.get(path, follow_redirects=False)
        self.assertEqual(res.status_code, 302, path)
        return res.headers["location"]

    def test_home_goes_to_the_site(self):
        self.assertEqual(self._to("/"), "https://meirasecretary.github.io/")

    def test_privacy_goes_to_the_one_policy(self):
        self.assertEqual(self._to("/privacy"), "https://meirasecretary.github.io/privacy.html")

    def test_delete_account_goes_to_the_web_deletion_page(self):
        self.assertEqual(self._to("/delete-account"), "https://meirasecretary.github.io/delete-account.html")


if __name__ == "__main__":
    unittest.main()
