import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException

import app


class AppStateTests(unittest.TestCase):
    def with_state_file(self):
        temp_dir = tempfile.TemporaryDirectory()
        state_path = os.path.join(temp_dir.name, "app_state.json")
        patcher = patch.object(app, "APP_STATE_FILE", state_path)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(temp_dir.cleanup)
        return state_path

    def test_default_state_has_yztrade_bookmarks(self):
        self.with_state_file()

        state = app.read_app_state()

        self.assertEqual(state["version"], 1)
        self.assertEqual(state["yzTrade"]["bookmarks"], {})

    def test_set_bookmark_persists_currency_price(self):
        self.with_state_file()

        app.set_app_state_bookmark("gfi", 0.123456)
        state = app.read_app_state()

        self.assertEqual(state["yzTrade"]["bookmarks"]["GFI"], 0.123456)

    def test_delete_bookmark_removes_currency(self):
        self.with_state_file()

        app.set_app_state_bookmark("GFI", 0.12)
        app.delete_app_state_bookmark("GFI")
        state = app.read_app_state()

        self.assertNotIn("GFI", state["yzTrade"]["bookmarks"])

    def test_invalid_bookmark_price_is_rejected(self):
        self.with_state_file()

        with self.assertRaises(HTTPException):
            app.set_app_state_bookmark("GFI", "nan")


if __name__ == "__main__":
    unittest.main()
