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
        avg_path = os.path.join(temp_dir.name, "avg_entries.json")
        patcher = patch.object(app, "APP_STATE_FILE", state_path)
        avg_patcher = patch.object(app, "AVG_ENTRIES_FILE", avg_path)
        patcher.start()
        avg_patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(avg_patcher.stop)
        self.addCleanup(temp_dir.cleanup)
        return state_path

    def test_default_state_has_yztrade_bookmarks(self):
        self.with_state_file()

        state = app.read_app_state()

        self.assertEqual(state["version"], 1)
        self.assertEqual(state["yzTrade"]["bookmarks"], {})
        self.assertNotIn("avgEntries", state["yzTrade"])
        self.assertEqual(app.read_avg_entries(), {})
        self.assertTrue(state["yzTrade"]["settings"]["balanceHistoryColored"])

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

    def test_balance_history_period_setting_persists(self):
        self.with_state_file()

        app.set_app_state_settings({"balanceHistoryPeriod": "30d"})
        state = app.read_app_state()

        self.assertEqual(state["yzTrade"]["settings"]["balanceHistoryPeriod"], "30d")

        app.set_app_state_settings({"balanceHistoryPeriod": "invalid"})
        state = app.read_app_state()

        self.assertEqual(state["yzTrade"]["settings"]["balanceHistoryPeriod"], "week")

    def test_balance_history_color_setting_persists(self):
        self.with_state_file()

        app.set_app_state_settings({"balanceHistoryColored": False})
        state = app.read_app_state()

        self.assertFalse(state["yzTrade"]["settings"]["balanceHistoryColored"])

    def test_avg_entry_lives_outside_app_state(self):
        self.with_state_file()

        app.set_app_state_bookmark("ICP", 2.237)
        app.set_app_state_settings({
            "balanceHistoryExpanded": True,
            "balanceHistoryPeriod": "30d",
            "balanceHistoryColored": False,
        })
        app.set_avg_entry_record(
            "PENGU",
            null_date="2026-08-13T00:00:00Z",
            avg_price=None,
            qty=0,
        )

        state = app.read_app_state()
        self.assertEqual(state["yzTrade"]["bookmarks"]["ICP"], 2.237)
        self.assertTrue(state["yzTrade"]["settings"]["balanceHistoryExpanded"])
        self.assertEqual(state["yzTrade"]["settings"]["balanceHistoryPeriod"], "30d")
        self.assertFalse(state["yzTrade"]["settings"]["balanceHistoryColored"])
        self.assertNotIn("avgEntries", state["yzTrade"])
        self.assertEqual(app.read_avg_entries()["PENGU"]["nullDate"], "2026-08-13T00:00:00Z")

        payload = app.app_state_payload()
        self.assertEqual(payload["yzTrade"]["avgEntries"]["PENGU"]["nullDate"], "2026-08-13T00:00:00Z")

    def test_concurrent_avg_writes_do_not_drop_bookmarks(self):
        from concurrent.futures import ThreadPoolExecutor

        self.with_state_file()
        app.set_app_state_bookmark("ICP", 2.237)
        app.set_app_state_settings({"balanceHistoryExpanded": True})

        def write_avg(index):
            app.set_avg_entry_record(
                "FET",
                null_date=f"2026-01-{(index % 28) + 1:02d}T00:00:00Z",
                avg_price=1.0 + index,
                qty=float(index + 1),
            )

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(write_avg, range(24)))
            app.set_app_state_bookmark("PENGU", 0.00618)

        state = app.read_app_state()
        self.assertEqual(state["yzTrade"]["bookmarks"]["ICP"], 2.237)
        self.assertAlmostEqual(state["yzTrade"]["bookmarks"]["PENGU"], 0.00618)
        self.assertTrue(state["yzTrade"]["settings"]["balanceHistoryExpanded"])
        self.assertNotIn("avgEntries", state["yzTrade"])
        self.assertIn("FET", app.read_avg_entries())

    def test_repeated_dust_poll_does_not_rewrite_null_date(self):
        self.with_state_file()
        app.set_avg_entry_record(
            "FET",
            null_date="2026-01-01T00:00:00Z",
            avg_price=None,
            qty=0,
        )

        with patch.object(app, "fetch_balances", return_value={
            "balances": [{
                "currency": "FET",
                "total": 0,
                "usd_price": 1,
                "usd_value": 0,
            }],
        }), patch.object(app, "fetch_fills_for_products") as fetch_fills:
            first = app.build_avg_entry_for_currency("FET", force=False)
            second = app.build_avg_entry_for_currency("FET", force=False)

        self.assertFalse(first["state_updated"])
        self.assertFalse(second["state_updated"])
        self.assertEqual(first["null_date"], "2026-01-01T00:00:00Z")
        self.assertEqual(app.get_avg_entry_record("FET")["nullDate"], "2026-01-01T00:00:00Z")
        fetch_fills.assert_not_called()


if __name__ == "__main__":
    unittest.main()
