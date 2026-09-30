import unittest
from unittest.mock import patch

import app


class OrdersListTests(unittest.TestCase):
    def setUp(self):
        with app._orders_list_lock:
            app._orders_list.clear()

    def tearDown(self):
        with app._orders_list_lock:
            app._orders_list.clear()

    def _open_sell(self):
        return app.orders_list_upsert_from_coinbase({
            "id": "sell-1",
            "product_id": "BTC-USD",
            "side": "sell",
            "status": "OPEN",
            "price": 100,
            "amount": 1,
            "order_type": "LIMIT",
        })

    def test_filled_sell_is_dropped(self):
        entry = self._open_sell()
        self.assertTrue(app.orders_list_apply_closed(entry["id"]))
        self.assertIsNone(app.orders_list_find(coinbase_id="sell-1"))

    def test_pending_buy_survives_cancel(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "buy-1",
            "product_id": "BTC-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 1,
            "amount": 10,
            "quote_size": 10,
            "order_type": "LIMIT",
        })
        app.orders_list_set_pending(entry["original_id"], 0.9)
        self.assertFalse(app.orders_list_apply_closed("buy-1"))
        kept = app.orders_list_find(original_id=entry["original_id"])
        self.assertEqual(str(kept["status"]).upper(), "PENDING")

    def test_pending_buy_survives_filled_close(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "buy-1",
            "product_id": "BTC-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 1,
            "amount": 10,
            "quote_size": 10,
            "order_type": "LIMIT",
        })
        app.orders_list_set_pending(entry["original_id"], 0.9)
        self.assertFalse(app.orders_list_apply_closed("buy-1"))
        kept = app.orders_list_find(original_id=entry["original_id"])
        self.assertEqual(str(kept["status"]).upper(), "PENDING")

    def test_error_is_kept(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "buy-err",
            "product_id": "BTC-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 1,
            "amount": 10,
            "quote_size": 10,
            "order_type": "LIMIT",
        })
        app.orders_list_set_error(entry["original_id"])
        self.assertFalse(app.orders_list_apply_closed("buy-err"))
        kept = app.orders_list_find(original_id=entry["original_id"])
        self.assertEqual(str(kept["status"]).upper(), "ERROR")

    def test_unrelated_buy_never_attaches_to_pending_same_base(self):
        pending = app.orders_list_upsert_from_coinbase({
            "id": "old-buy",
            "product_id": "FET-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 0.2,
            "amount": 10,
            "quote_size": 10,
            "order_type": "LIMIT",
        })
        app.orders_list_set_pending(pending["original_id"], 0.15)
        unrelated = app.orders_list_upsert_from_coinbase({
            "id": "new-buy",
            "product_id": "FET-USDC",
            "side": "buy",
            "status": "OPEN",
            "price": 0.15,
            "amount": 10,
            "quote_size": 10,
            "order_type": "LIMIT",
        })
        with app._orders_list_lock:
            buys = [
                entry for entry in app._orders_list
                if str(entry.get("side") or "").lower() == "buy"
            ]
        self.assertEqual(len(buys), 2)
        self.assertNotEqual(unrelated["original_id"], pending["original_id"])
        kept_pending = app.orders_list_find(original_id=pending["original_id"])
        self.assertEqual(kept_pending["id"], "old-buy")
        self.assertEqual(str(kept_pending["status"]).upper(), "PENDING")

    def test_replacement_updates_only_exact_original_id(self):
        moved = app.orders_list_upsert_from_coinbase({
            "id": "move-old",
            "product_id": "GFI-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 0.03,
            "amount": 100,
            "quote_size": 3,
            "order_type": "LIMIT",
        })
        sibling = app.orders_list_upsert_from_coinbase({
            "id": "sibling",
            "product_id": "GFI-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 0.031,
            "amount": 100,
            "quote_size": 3.1,
            "order_type": "LIMIT",
        })
        app.orders_list_set_pending(moved["original_id"], 0.029)

        transitioned = app.orders_list_transition_success(
            moved["original_id"],
            "move-new",
            0.029,
            normalized={
                "id": "move-new",
                "product_id": "GFI-USD",
                "side": "buy",
                "status": "OPEN",
                "price": 0.029,
                "amount": 100,
                "quote_size": 2.9,
                "order_type": "LIMIT",
            },
        )

        self.assertEqual(transitioned["original_id"], moved["original_id"])
        self.assertEqual(
            app.orders_list_find(original_id=moved["original_id"])["id"],
            "move-new",
        )
        kept_sibling = app.orders_list_find(original_id=sibling["original_id"])
        self.assertEqual(kept_sibling["id"], "sibling")
        self.assertEqual(str(kept_sibling["status"]).upper(), "OPEN")

    def test_client_order_id_does_not_remint_pending_original_id(self):
        pending = app.orders_list_upsert_from_coinbase({
            "id": "old-cb",
            "product_id": "GFI-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 0.03,
            "amount": 100,
            "quote_size": 3,
            "order_type": "LIMIT",
        })
        original_id = pending["original_id"]
        app.orders_list_set_pending(original_id, 0.029)
        with app._orders_list_lock:
            entry = app._orders_find_locked(original_id=original_id)
            entry["client_order_id"] = "client-xyz"

        incoming = app.orders_list_upsert_from_coinbase({
            "id": "new-cb",
            "product_id": "GFI-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 0.04,
            "amount": 100,
            "quote_size": 4,
            "order_type": "LIMIT",
            "client_order_id": "client-xyz",
        })

        with app._orders_list_lock:
            self.assertEqual(len(app._orders_list), 1)
        self.assertEqual(incoming["original_id"], original_id)
        kept = app.orders_list_find(original_id=original_id)
        self.assertEqual(str(kept["status"]).upper(), "PENDING")
        self.assertEqual(kept["price"], 0.029)
        self.assertEqual(kept["id"], "old-cb")

    def test_pending_and_error_rows_ignore_generic_coinbase_updates(self):
        pending = app.orders_list_upsert_from_coinbase({
            "id": "pending-cb",
            "product_id": "GFI-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 0.03,
            "amount": 100,
            "quote_size": 3,
            "order_type": "LIMIT",
        })
        app.orders_list_set_pending(pending["original_id"], 0.029)
        app.orders_list_upsert_from_coinbase({
            "id": "pending-cb",
            "product_id": "GFI-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 0.04,
            "amount": 100,
            "quote_size": 4,
            "order_type": "LIMIT",
        })
        kept_pending = app.orders_list_find(original_id=pending["original_id"])
        self.assertEqual(str(kept_pending["status"]).upper(), "PENDING")
        self.assertEqual(kept_pending["price"], 0.029)

        error = app.orders_list_upsert_from_coinbase({
            "id": "error-cb",
            "product_id": "GFI-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 0.032,
            "amount": 100,
            "quote_size": 3.2,
            "order_type": "LIMIT",
        })
        app.orders_list_set_error(error["original_id"])
        app.orders_list_upsert_from_coinbase({
            "id": "error-cb",
            "product_id": "GFI-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 0.05,
            "amount": 100,
            "quote_size": 5,
            "order_type": "LIMIT",
        })
        kept_error = app.orders_list_find(original_id=error["original_id"])
        self.assertEqual(str(kept_error["status"]).upper(), "ERROR")
        self.assertEqual(kept_error["price"], 0.032)

    def test_public_view_uses_local_id_only(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "aaaa-bbbb-cccc",
            "product_id": "BTC-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 1,
            "amount": 10,
            "quote_size": 10,
            "order_type": "LIMIT",
        })
        public = app.order_public_view(entry)
        self.assertTrue(str(public["original_id"]).startswith("order-"))
        self.assertNotIn("id", public)
        self.assertNotIn("coinbase_id", public)
        self.assertNotIn("client_order_id", public)

    def test_sync_keeps_open_sell_missing_from_one_snapshot(self):
        entry = self._open_sell()
        app.orders_list_sync_from_coinbase([])
        kept = app.orders_list_find(original_id=entry["original_id"])
        self.assertIsNotNone(kept)
        self.assertEqual(kept["id"], "sell-1")

    def test_sync_keeps_just_placed_order_missing_from_coinbase(self):
        entry = app.orders_list_upsert_from_coinbase(
            {
                "id": "bracket-new",
                "product_id": "BTC-USD",
                "side": "sell",
                "status": "OPEN",
                "price": 110,
                "amount": 1,
                "order_type": "BRACKET",
                "bracket_legs": [],
            },
            place_payload={
                "order_type": "BRACKET",
                "side": "SELL",
                "take_profit_price": 110,
                "stop_loss_price": 90,
                "base_size": 1,
            },
        )
        self.assertEqual(len(entry.get("bracket_legs") or []), 2)
        app.orders_list_sync_from_coinbase([])
        kept = app.orders_list_find(coinbase_id="bracket-new")
        self.assertIsNotNone(kept)
        self.assertEqual(len(kept.get("bracket_legs") or []), 2)

    def test_sync_incomplete_bracket_does_not_wipe_legs(self):
        app.orders_list_upsert_from_coinbase(
            {
                "id": "bracket-2",
                "product_id": "BTC-USD",
                "side": "sell",
                "status": "OPEN",
                "price": 110,
                "amount": 1,
                "order_type": "BRACKET",
                "bracket_legs": [],
            },
            place_payload={
                "order_type": "BRACKET",
                "side": "SELL",
                "take_profit_price": 110,
                "stop_loss_price": 90,
                "base_size": 1,
            },
        )
        # Coinbase open-list catch-up without trigger_bracket_gtc → empty legs.
        app.orders_list_upsert_from_coinbase({
            "id": "bracket-2",
            "product_id": "BTC-USD",
            "side": "sell",
            "status": "OPEN",
            "price": 110,
            "amount": 1,
            "order_type": "LIMIT",
            "bracket_legs": [],
        })
        kept = app.orders_list_find(coinbase_id="bracket-2")
        self.assertIsNotNone(kept)
        self.assertEqual(str(kept.get("order_type") or "").upper(), "BRACKET")
        self.assertEqual(len(kept.get("bracket_legs") or []), 2)

    def test_place_payload_fills_same_fields_as_limit_shape(self):
        seeded = app.build_normalized_from_place_payload(
            "cb-1",
            "BTC-USD",
            "sell",
            "BRACKET",
            {
                "order_type": "BRACKET",
                "take_profit_price": 120,
                "stop_loss_price": 80,
                "base_size": 2,
                "preview_base_size": 2,
            },
        )
        self.assertEqual(seeded["order_type"], "BRACKET")
        self.assertEqual(seeded["price"], 120)
        roles = {leg["role"] for leg in seeded["bracket_legs"]}
        self.assertEqual(roles, {"take_profit", "stop_loss"})

    def test_cancel_already_gone_removes_local_row(self):
        entry = self._open_sell()
        local_id = entry["original_id"]

        with patch.object(app, "coinbase_advanced_post", return_value={
            "results": [{"success": False, "failure_reason": "UNKNOWN_CANCEL_ORDER"}],
        }):
            response = app.cancel_order.__wrapped__(local_id)

        self.assertTrue(response["success"])
        self.assertTrue(response["removed"])
        self.assertTrue(response["already_gone"])
        self.assertIsNone(app.orders_list_find(original_id=local_id))

    def test_cancel_filled_historical_removes_local_row(self):
        entry = self._open_sell()
        local_id = entry["original_id"]

        with patch.object(app, "coinbase_advanced_post", return_value={
            "results": [{"success": False, "failure_reason": "SOME_OTHER_REASON"}],
        }), patch.object(app, "coinbase_advanced_get", return_value={
            "order": {"order_id": "sell-1", "status": "FILLED"},
        }):
            response = app.cancel_order.__wrapped__(local_id)

        self.assertTrue(response["success"])
        self.assertTrue(response["removed"])
        self.assertTrue(response["already_gone"])
        self.assertIsNone(app.orders_list_find(original_id=local_id))

    def test_pending_move_keeps_parent_used_dollars(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "buy-leg-1",
            "product_id": "BTC-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 100,
            "amount": 1,
            "filled_size": 0.04,
            "quote_size": 100,
            "order_type": "LIMIT",
        }, raw_order={
            "order_id": "buy-leg-1",
            "side": "BUY",
            "filled_size": "0.04",
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "100",
                    "limit_price": "100",
                },
            },
        })
        self.assertAlmostEqual(entry["used_value_usd"], 4.0, places=6)
        self.assertAlmostEqual(
            entry["used_value_usd"] / entry["original_value_usd"] * 100.0,
            4.0,
            places=6,
        )

        pending = app.orders_list_set_pending(entry["original_id"], 90)
        self.assertEqual(str(pending["status"]).upper(), "PENDING")
        self.assertAlmostEqual(pending["used_value_usd"], 4.0, places=6)
        self.assertNotIn("used_percent", pending)
        self.assertAlmostEqual(pending["remaining_value_usd"], 96.0, places=6)
        self.assertAlmostEqual(pending["original_value_usd"], 100.0, places=6)

        public = app.order_public_view(app.orders_list_find(original_id=entry["original_id"]))
        self.assertNotIn("used_percent", public)
        self.assertAlmostEqual(public["used_value_usd"], 4.0, places=6)

        replaced = app.orders_list_transition_success(
            entry["original_id"],
            "buy-leg-2",
            90,
            normalized={
                "id": "buy-leg-2",
                "product_id": "BTC-USD",
                "side": "buy",
                "status": "OPEN",
                "price": 90,
                "filled_size": 0,
                "quote_size": 96,
                "order_type": "LIMIT",
            },
        )
        self.assertAlmostEqual(replaced["used_value_usd"], 4.0, places=6)
        self.assertNotIn("used_percent", replaced)
        self.assertAlmostEqual(replaced["remaining_value_usd"], 96.0, places=6)

    def test_pending_child_snapshot_does_not_double_count_used(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "buy-leg-a",
            "product_id": "PENGU-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 100,
            "amount": 25.6,
            "filled_size": 18.0,
            "quote_size": 2560,
            "order_type": "LIMIT",
        }, raw_order={
            "order_id": "buy-leg-a",
            "side": "BUY",
            "filled_size": "18",
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "2560",
                    "limit_price": "100",
                },
            },
        })
        self.assertAlmostEqual(entry["original_value_usd"], 2560.0, places=6)
        self.assertAlmostEqual(entry["used_value_usd"], 1800.0, places=6)
        self.assertAlmostEqual(
            entry["used_value_usd"] / entry["original_value_usd"] * 100.0,
            1800.0 / 2560.0 * 100.0,
            places=6,
        )

        original_id = entry["original_id"]
        app.orders_list_set_pending(original_id, 90)

        # Same child fill snapshot during PENDING must not push USED to 100%.
        again = app.orders_list_upsert_from_coinbase({
            "id": "buy-leg-a",
            "product_id": "PENGU-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 100,
            "amount": 7.6,
            "filled_size": 18.0,
            "quote_size": 2560,
            "order_type": "LIMIT",
        }, raw_order={
            "order_id": "buy-leg-a",
            "side": "BUY",
            "filled_size": "18",
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "2560",
                    "limit_price": "100",
                },
            },
        })
        self.assertEqual(str(again["status"]).upper(), "PENDING")
        self.assertAlmostEqual(again["used_value_usd"], 1800.0, places=6)
        self.assertAlmostEqual(again["remaining_value_usd"], 760.0, places=6)

        # Leftover filled_size on transition must not double-count either.
        replaced = app.orders_list_transition_success(
            original_id,
            "buy-leg-b",
            90,
            normalized={
                "id": "buy-leg-b",
                "product_id": "PENGU-USD",
                "side": "buy",
                "status": "OPEN",
                "price": 90,
                "quote_size": 760,
                "order_type": "LIMIT",
                # omit filled_size on purpose — old child fill must not stick
            },
        )
        self.assertAlmostEqual(replaced["used_value_usd"], 1800.0, places=6)
        self.assertAlmostEqual(replaced["remaining_value_usd"], 760.0, places=6)
        self.assertNotIn("used_percent", replaced)
        self.assertLess(replaced["used_value_usd"] / replaced["original_value_usd"] * 100.0, 100.0)

    def test_used_prefers_filled_value_over_limit_times_size(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "buy-fv-1",
            "product_id": "BTC-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 100,
            "amount": 10,
            "filled_size": 5,
            "quote_size": 1286.41,
            "order_type": "LIMIT",
        }, raw_order={
            "order_id": "buy-fv-1",
            "side": "BUY",
            "filled_size": "5",
            "filled_value": "900",
            "average_filled_price": "90",
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "1286.41",
                    "limit_price": "100",
                },
            },
        })
        self.assertAlmostEqual(entry["original_value_usd"], 1286.41, places=6)
        self.assertAlmostEqual(entry["used_value_usd"], 900.0, places=6)
        self.assertAlmostEqual(entry["remaining_value_usd"], 1286.41 - 900.0, places=6)
        self.assertAlmostEqual(
            entry["used_value_usd"] / entry["original_value_usd"] * 100.0,
            900.0 / 1286.41 * 100.0,
            places=6,
        )

    def test_move_does_not_revalue_prior_fills_at_new_limit(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "buy-move-1",
            "product_id": "BTC-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 100,
            "amount": 12.8641,
            "filled_size": 9,
            "quote_size": 1286.41,
            "order_type": "LIMIT",
        }, raw_order={
            "order_id": "buy-move-1",
            "side": "BUY",
            "filled_size": "9",
            "filled_value": "900",
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "1286.41",
                    "limit_price": "100",
                },
            },
        })
        self.assertAlmostEqual(entry["used_value_usd"], 900.0, places=6)

        pending = app.orders_list_set_pending(entry["original_id"], 150)
        self.assertEqual(str(pending["status"]).upper(), "PENDING")
        self.assertAlmostEqual(pending["used_value_usd"], 900.0, places=6)
        self.assertAlmostEqual(pending["remaining_value_usd"], 1286.41 - 900.0, places=6)
        self.assertNotIn("used_before_current_order_usd", pending)
        internal = app.orders_list_find(original_id=entry["original_id"])
        self.assertAlmostEqual(internal["used_before_current_order_usd"], 900.0, places=6)

        # Finalize must not revalue 9 coins at the new $150 limit.
        public = app.order_public_view(app.orders_list_find(original_id=entry["original_id"]))
        self.assertAlmostEqual(public["used_value_usd"], 900.0, places=6)
        self.assertNotIn("used_percent", public)
        self.assertAlmostEqual(
            public["used_value_usd"] / public["original_value_usd"] * 100.0,
            900.0 / 1286.41 * 100.0,
            places=4,
        )

        replaced = app.orders_list_transition_success(
            entry["original_id"],
            "buy-move-2",
            150,
            normalized={
                "id": "buy-move-2",
                "product_id": "BTC-USD",
                "side": "buy",
                "status": "OPEN",
                "price": 150,
                "filled_size": 0,
                "quote_size": 386.41,
                "order_type": "LIMIT",
            },
        )
        self.assertAlmostEqual(replaced["used_value_usd"], 900.0, places=6)
        self.assertAlmostEqual(replaced["remaining_value_usd"], 1286.41 - 900.0, places=6)
        self.assertNotIn("used_before_current_order_usd", replaced)

        # New child partial fill adds only that child's fill $.
        again = app.orders_list_upsert_from_coinbase({
            "id": "buy-move-2",
            "product_id": "BTC-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 150,
            "filled_size": 0.5,
            "quote_size": 386.41,
            "order_type": "LIMIT",
            "original_id": entry["original_id"],
        }, raw_order={
            "order_id": "buy-move-2",
            "side": "BUY",
            "filled_size": "0.5",
            "filled_value": "75",
            "client_order_id": entry["original_id"],
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "386.41",
                    "limit_price": "150",
                },
            },
        })
        self.assertAlmostEqual(again["used_value_usd"], 975.0, places=6)
        self.assertAlmostEqual(again["remaining_value_usd"], 1286.41 - 975.0, places=6)


if __name__ == "__main__":
    unittest.main()
