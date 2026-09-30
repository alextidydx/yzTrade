import os
import json
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import app


def fill(side, price, size, day, commission=0, size_in_quote=False):
    stamp = datetime(2026, 1, day, 12, 0, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "side": side,
        "price": str(price),
        "size": str(size),
        "size_in_quote": size_in_quote,
        "commission": str(commission),
        "product_id": "FET-USD",
        "trade_time": stamp,
    }


class AvgEntryTests(unittest.TestCase):
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

    def test_weighted_average_after_buys(self):
        result = app.compute_avg_entry_from_fills([
            fill("BUY", 1.0, 10, 1),
            fill("BUY", 3.0, 10, 2),
        ])

        self.assertAlmostEqual(result["avg_price"], 2.0)
        self.assertAlmostEqual(result["qty"], 20.0)
        self.assertIsNone(result["null_date"])

    def test_quote_sized_buy_converts_to_base_quantity(self):
        row = app.normalize_fill_row(
            fill(
                "BUY",
                0.01,
                100,
                1,
                commission=0.075,
                size_in_quote=True,
            )
        )

        self.assertAlmostEqual(row["size"], 10000.0)
        self.assertAlmostEqual(row["quote_size"], 100.0)
        self.assertTrue(row["size_in_quote"])

        result = app.compute_avg_entry_from_fills([
            fill(
                "BUY",
                0.01,
                100,
                1,
                commission=0.075,
                size_in_quote=True,
            ),
        ], balance_qty=10000)

        # Avg entry uses trade price only (no fees).
        self.assertAlmostEqual(result["avg_price"], 0.01)
        self.assertAlmostEqual(result["qty"], 10000.0)

    def test_null_date_resets_when_flat(self):
        result = app.compute_avg_entry_from_fills([
            fill("BUY", 2.0, 10, 1),
            fill("SELL", 2.0, 10, 2),
            fill("BUY", 5.0, 4, 3),
        ])

        self.assertAlmostEqual(result["avg_price"], 5.0)
        self.assertAlmostEqual(result["qty"], 4.0)
        self.assertTrue(str(result["null_date"]).startswith("2026-01-02"))

    def test_partial_sell_keeps_weighted_avg(self):
        result = app.compute_avg_entry_from_fills([
            fill("BUY", 1.0, 10, 1),
            fill("BUY", 3.0, 10, 2),
            fill("SELL", 2.5, 10, 3),
        ], balance_qty=10)

        # Coinbase-style: avg stays 2.0; sell only cuts qty.
        self.assertAlmostEqual(result["avg_price"], 2.0)
        self.assertAlmostEqual(result["qty"], 10.0)

    def test_partial_sell_ignores_fees_in_avg(self):
        result = app.compute_avg_entry_from_fills([
            fill("BUY", 1.0, 10, 1, commission=0.10),
            fill("BUY", 3.0, 10, 2, commission=0.30),
            fill("SELL", 2.5, 10, 3, commission=0.25),
        ], balance_qty=10)

        self.assertAlmostEqual(result["avg_price"], 2.0)
        self.assertAlmostEqual(result["qty"], 10.0)

    def test_partial_sell_with_negative_size(self):
        # Some Coinbase responses may represent SELL size as signed.
        result = app.compute_avg_entry_from_fills([
            fill("BUY", 1.0, 10, 1),
            fill("BUY", 3.0, 10, 2),
            fill("SELL", 2.5, -10, 3),
        ], balance_qty=10)

        self.assertAlmostEqual(result["avg_price"], 2.0)
        self.assertAlmostEqual(result["qty"], 10.0)

    def test_qty_mismatch_uses_newest_buys(self):
        # Fill inventory (20) > live bag (10): missing sells / truncated history.
        result = app.compute_avg_entry_from_fills([
            fill("BUY", 1.0, 10, 1),
            fill("BUY", 3.0, 10, 2),
        ], balance_qty=10)

        self.assertAlmostEqual(result["avg_price"], 3.0)
        self.assertEqual(result.get("source"), "newest_buys")

    def test_underfill_keeps_forward_avg(self):
        # Fill inventory after flat (100) < live bag (500): deposits/gaps.
        # Keep spot forward avg — do not dilute with newest-buys over whole wallet.
        result = app.compute_avg_entry_from_fills([
            fill("BUY", 0.02, 100000, 1),
            fill("SELL", 0.02, 100000, 2),
            fill("BUY", 0.006, 50, 3),
            fill("BUY", 0.00636, 50, 4),
        ], balance_qty=500)

        self.assertAlmostEqual(result["avg_price"], 0.00618)
        self.assertEqual(result.get("source"), "forward_underfill")

    def test_newest_buys_ignores_ancient_sell_expansion(self):
        # Forward inventory after flat is 100, but live bag is smaller.
        # Cover from newest buys only — not ancient pre-flat prices.
        result = app.compute_avg_entry_from_fills([
            fill("BUY", 0.02, 100000, 1),
            fill("SELL", 0.02, 100000, 2),
            fill("BUY", 0.006, 50, 3),
            fill("BUY", 0.007, 50, 4),
        ], balance_qty=80)

        self.assertAlmostEqual(result["avg_price"], (50 * 0.007 + 30 * 0.006) / 80)
        self.assertEqual(result.get("source"), "newest_buys")

    def test_persists_avg_entry_and_serves_cache(self):
        self.with_state_file()

        app.set_avg_entry_record("fet", null_date="2026-01-01T00:00:00Z", avg_price=2.5, qty=10)
        stored = app.get_avg_entry_record("FET")

        self.assertEqual(stored["avgPrice"], 2.5)
        self.assertEqual(stored["qty"], 10.0)
        self.assertNotIn("avgEntries", app.read_app_state()["yzTrade"])

        with patch.object(app, "fetch_balances", return_value={
            "balances": [{
                "currency": "FET",
                "total": 10,
                "usd_price": 3,
                "usd_value": 30,
            }],
        }), patch.object(app, "fetch_fills_for_products") as fetch_fills:
            result = app.build_avg_entry_for_currency("FET", force=False)

            self.assertEqual(result["source"], "cache")
            self.assertAlmostEqual(result["avg_price"], 2.5)
            self.assertTrue(result["tracked"])
            fetch_fills.assert_not_called()

    def test_force_recompute_updates_persisted_avg(self):
        self.with_state_file()
        app.set_avg_entry_record("fet", null_date=None, avg_price=9.0, qty=1)

        with patch.object(app, "fetch_balances", return_value={
            "balances": [{
                "currency": "FET",
                "total": 20,
                "usd_price": 2,
                "usd_value": 40,
            }],
        }), patch.object(app, "fetch_fills_for_products", return_value=[
            fill("BUY", 1.0, 10, 1),
            fill("BUY", 3.0, 10, 2),
        ]):
            result = app.build_avg_entry_for_currency("FET", force=True)

        self.assertEqual(result["source"], "recompute")
        self.assertAlmostEqual(result["avg_price"], 2.0)
        self.assertTrue(result["state_updated"])
        stored = app.get_avg_entry_record("FET")
        self.assertAlmostEqual(stored["avgPrice"], 2.0)

    def test_newest_buys_flash_keeps_stored_avg(self):
        """Add-on buy must not yank the line to the latest fill via newest_buys."""
        self.with_state_file()
        app.set_avg_entry_record("fet", null_date="2026-01-01T00:00:00Z", avg_price=2.5, qty=100)

        with patch.object(app, "fetch_balances", return_value={
            "balances": [{
                "currency": "FET",
                "total": 110,
                "usd_price": 1,
                "usd_value": 110,
            }],
        }), patch.object(app, "fetch_fills_for_products", return_value=[
            fill("BUY", 2.0, 1000, 1),
            fill("BUY", 3.0, 1000, 2),
            fill("BUY", 1.0, 110, 3),
        ]):
            result = app.build_avg_entry_for_currency("FET", force=True)

        self.assertEqual(result["reason"], "newest_buys_flash_keep_cache")
        self.assertEqual(result["source"], "cache")
        self.assertAlmostEqual(result["avg_price"], 2.5)
        self.assertFalse(result["state_updated"])
        stored = app.get_avg_entry_record("FET")
        self.assertAlmostEqual(stored["avgPrice"], 2.5)

    def test_force_recompute_respects_stored_dust_boundary(self):
        self.with_state_file()
        boundary = "2026-01-01T00:00:00Z"
        app.set_avg_entry_record("fet", null_date=boundary, avg_price=9.0, qty=10)

        with patch.object(app, "fetch_balances", return_value={
            "balances": [{
                "currency": "FET",
                "total": 10,
                "usd_price": 3,
                "usd_value": 30,
            }],
        }), patch.object(
            app,
            "fetch_fills_for_products",
            return_value=[fill("BUY", 2.0, 10, 2)],
        ) as fetch_fills:
            result = app.build_avg_entry_for_currency("FET", force=True)

        self.assertAlmostEqual(result["avg_price"], 2.0)
        self.assertEqual(fetch_fills.call_count, 1)
        self.assertEqual(
            fetch_fills.call_args.kwargs.get("start_time_iso"),
            boundary,
        )

    def test_migrates_legacy_avg_from_app_state_file(self):
        self.with_state_file()
        with open(app.APP_STATE_FILE, "w", encoding="utf-8") as handle:
            json.dump({
                "version": 1,
                "yzTrade": {
                    "bookmarks": {"ICP": 2.2},
                    "avgEntries": {
                        "FET": {
                            "nullDate": "2026-01-01T00:00:00Z",
                            "avgPrice": None,
                            "qty": 0,
                        },
                    },
                    "avgEntryNullDates": {"PENGU": "2026-02-01T00:00:00Z"},
                    "settings": {},
                },
            }, handle)

        entries = app.read_avg_entries()
        self.assertEqual(entries["FET"]["nullDate"], "2026-01-01T00:00:00Z")
        self.assertEqual(entries["PENGU"]["nullDate"], "2026-02-01T00:00:00Z")

        with open(app.APP_STATE_FILE, "r", encoding="utf-8") as handle:
            state = app.normalize_app_state(json.load(handle))
        self.assertNotIn("avgEntries", state["yzTrade"])
        self.assertNotIn("avgEntryNullDates", state["yzTrade"])
        self.assertEqual(state["yzTrade"]["bookmarks"]["ICP"], 2.2)

    def test_unpriced_balance_does_not_wipe_cache_as_dust(self):
        self.with_state_file()
        app.set_avg_entry_record("fet", null_date="2026-01-01T00:00:00Z", avg_price=2.5, qty=10)

        with patch.object(app, "fetch_balances", return_value={
            "balances": [{
                "currency": "FET",
                "total": 10,
                "usd_price": None,
                "usd_value": None,
            }],
        }), patch.object(app, "fetch_fills_for_products") as fetch_fills:
            result = app.build_avg_entry_for_currency("FET", force=False)

        self.assertEqual(result["source"], "cache")
        self.assertAlmostEqual(result["avg_price"], 2.5)
        self.assertTrue(result["tracked"])
        fetch_fills.assert_not_called()
        stored = app.get_avg_entry_record("FET")
        self.assertAlmostEqual(stored["avgPrice"], 2.5)

    def test_poisoned_null_date_backfills_without_start(self):
        self.with_state_file()
        app.set_avg_entry_record(
            "fet",
            null_date="2026-08-12T22:19:58Z",
            avg_price=None,
            qty=0,
        )

        def fake_fills(product_ids, start_time_iso=None):
            if start_time_iso:
                return []
            return [
                fill("BUY", 1.0, 10, 1),
                fill("BUY", 3.0, 10, 2),
            ]

        with patch.object(app, "fetch_balances", return_value={
            "balances": [{
                "currency": "FET",
                "total": 20,
                "usd_price": 2,
                "usd_value": 40,
            }],
        }), patch.object(app, "fetch_fills_for_products", side_effect=fake_fills):
            result = app.build_avg_entry_for_currency("FET", force=True)

        self.assertEqual(result["source"], "recompute")
        self.assertAlmostEqual(result["avg_price"], 2.0)
        self.assertTrue(result["tracked"])
        stored = app.get_avg_entry_record("FET")
        self.assertAlmostEqual(stored["avgPrice"], 2.0)

    def test_empty_recompute_keeps_existing_avg(self):
        self.with_state_file()
        app.set_avg_entry_record("fet", null_date="2026-01-01T00:00:00Z", avg_price=4.0, qty=5)

        with patch.object(app, "fetch_balances", return_value={
            "balances": [{
                "currency": "FET",
                "total": 5,
                "usd_price": 2,
                "usd_value": 10,
            }],
        }), patch.object(app, "fetch_fills_for_products", return_value=[]):
            result = app.build_avg_entry_for_currency("FET", force=True)

        self.assertIn(result["reason"], {"no_fills_keep_cache", "qty_mismatch_keep_cache"})
        self.assertAlmostEqual(result["avg_price"], 4.0)
        stored = app.get_avg_entry_record("FET")
        self.assertAlmostEqual(stored["avgPrice"], 4.0)

    def test_failed_recompute_does_not_persist_null_avg(self):
        self.with_state_file()
        app.set_avg_entry_record("fet", null_date=None, avg_price=None, qty=0)

        with patch.object(app, "fetch_balances", return_value={
            "balances": [{
                "currency": "FET",
                "total": 100,
                "usd_price": 2,
                "usd_value": 200,
            }],
        }), patch.object(app, "fetch_fills_for_products", return_value=[]):
            result = app.build_avg_entry_for_currency("FET", force=True)

        self.assertIsNone(result["avg_price"])
        stored = app.get_avg_entry_record("FET") or {}
        self.assertIsNone(stored.get("avgPrice"))
        self.assertFalse(result["state_updated"])


if __name__ == "__main__":
    unittest.main()
