import unittest
from unittest.mock import patch

from fastapi import HTTPException

import app


class EditOrderTests(unittest.TestCase):
    def setUp(self):
        with app._orders_list_lock:
            app._orders_list.clear()

    def tearDown(self):
        with app._orders_list_lock:
            app._orders_list.clear()

    def edit(self, payload):
        return app.edit_order.__wrapped__(payload)

    def test_edit_order_requires_price(self):
        with self.assertRaises(HTTPException) as missing_price:
            self.edit({
                "original_id": "abc",
            })

        self.assertEqual(missing_price.exception.status_code, 400)

    def test_edit_order_posts_formatted_body_resolving_size(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "abc",
            "product_id": "BTC-USD",
            "side": "sell",
            "status": "OPEN",
            "price": 100,
            "amount": 0.12345,
            "base_size": 0.12345,
            "order_type": "LIMIT",
        })

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.01",
            "base_increment": "0.0001",
        }), patch.object(app, "coinbase_advanced_post", return_value={
            "success": True,
        }) as post, patch.object(app, "coinbase_advanced_get", return_value={
            "order": {
                "order_id": "abc",
                "product_id": "BTC-USD",
                "side": "SELL",
                "status": "OPEN",
                "filled_size": "0",
                "order_configuration": {
                    "limit_limit_gtc": {
                        "base_size": "0.12345",
                        "limit_price": "100",
                    },
                },
            },
        }):
            response = self.edit({
                "original_id": entry["original_id"],
                "price": 101.234,
                "stop_price": 90.987,
            })

        self.assertTrue(response["success"])
        self.assertEqual(post.call_args.args[0], "/api/v3/brokerage/orders/edit")
        self.assertEqual(post.call_args.args[1], {
            "order_id": "abc",
            "price": "101.23",
            "size": "0.1234",
            "stop_price": "90.98",
        })

    def test_edit_rejects_trailing_ids(self):
        with self.assertRaises(HTTPException) as err:
            self.edit({
                "original_id": "trailing-abc",
                "price": 100,
            })

        self.assertEqual(err.exception.status_code, 400)

    def test_sell_edit_stamps_requested_price_as_open(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "sell-1",
            "product_id": "ICP-USDC",
            "side": "sell",
            "status": "PENDING",
            "price": 2.6975,
            "amount": 512.7627,
            "base_size": 512.7627,
            "order_type": "LIMIT",
        })
        local_id = entry["original_id"]

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.0001",
            "base_increment": "0.0001",
        }), patch.object(app, "coinbase_advanced_post", return_value={
            "success": True,
        }), patch.object(app, "coinbase_advanced_get", return_value={
            "order": {
                "order_id": "sell-1",
                "product_id": "ICP-USDC",
                "side": "SELL",
                "status": "PENDING",
                "filled_size": "0",
                "order_configuration": {
                    "limit_limit_gtc": {
                        "base_size": "512.7627",
                        "limit_price": "2.6975",
                    },
                },
            },
        }):
            response = self.edit({
                "original_id": local_id,
                "price": 2.6203267331005407,
            })

        self.assertTrue(response["success"])
        self.assertEqual(str(response["order"]["status"]).upper(), "OPEN")
        self.assertAlmostEqual(response["order"]["price"], 2.6203267331005407, places=8)
        kept = app.orders_list_find(original_id=local_id)
        self.assertEqual(str(kept["status"]).upper(), "OPEN")
        self.assertAlmostEqual(kept["price"], 2.6203267331005407, places=8)

    def test_coinbase_pending_sell_is_stored_as_open(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "sell-pending",
            "product_id": "ICP-USDC",
            "side": "sell",
            "status": "PENDING",
            "price": 2.5,
            "amount": 10,
            "order_type": "LIMIT",
        })
        self.assertEqual(str(entry["status"]).upper(), "OPEN")

    def test_backend_pending_status_blocks_another_edit(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "pending-buy",
            "product_id": "GFI-USD",
            "side": "buy",
            "status": "OPEN",
            "price": 0.03,
            "amount": 100,
            "quote_size": 3,
            "order_type": "LIMIT",
        })
        app.orders_list_set_pending(entry["original_id"], 0.029)

        with self.assertRaises(HTTPException) as blocked:
            self.edit({
                "original_id": entry["original_id"],
                "price": 0.028,
            })

        self.assertEqual(blocked.exception.status_code, 409)
        self.assertEqual(blocked.exception.detail["status"], "PENDING")
        self.assertEqual(
            blocked.exception.detail["original_id"],
            entry["original_id"],
        )

    def test_edit_buy_limit_cancels_and_replaces_with_quote_size(self):
        raw_order = {
            "order_id": "abc",
            "product_id": "FET-USDC",
            "side": "BUY",
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "100",
                    "limit_price": "0.14",
                    "post_only": False,
                },
            },
        }
        placed_order = {
            "order_id": "new-abc",
            "product_id": "FET-USDC",
            "side": "BUY",
            "status": "OPEN",
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "100",
                    "limit_price": "0.20",
                    "post_only": False,
                },
            },
        }
        entry = app.orders_list_upsert_from_coinbase(
            app.normalize_order(raw_order),
            raw_order=raw_order,
        )

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.00001",
            "base_increment": "0.1",
        }), patch.object(app, "coinbase_advanced_get", side_effect=[
            {"order": raw_order},
            {"order": raw_order},
            {"order": placed_order},
        ]), patch.object(app, "coinbase_advanced_post", side_effect=[
            {"results": [{"success": True}]},
            {"success": True, "success_response": {"order_id": "new-abc"}},
        ]) as post:
            response = self.edit({
                "original_id": entry["original_id"],
                "price": 0.20,
            })

        self.assertTrue(response["success"])
        self.assertTrue(response["replaced"])
        self.assertEqual(response["original_id"], entry["original_id"])
        self.assertEqual(response["order"]["original_id"], entry["original_id"])
        self.assertNotIn("id", response["order"])
        self.assertNotIn("coinbase_id", response["order"])
        self.assertEqual(post.call_args_list[0].args[0], "/api/v3/brokerage/orders/batch_cancel")
        self.assertEqual(post.call_args_list[1].args[0], "/api/v3/brokerage/orders")
        place_config = post.call_args_list[1].args[1]["order_configuration"]["limit_limit_gtc"]
        self.assertEqual(place_config["limit_price"], "0.20000")
        self.assertEqual(place_config["quote_size"], "100.00000")
        self.assertNotIn("base_size", place_config)

    def test_edit_buy_base_limit_replace_uses_old_notional_as_quote(self):
        raw_order = {
            "order_id": "abc",
            "product_id": "FET-USDC",
            "side": "BUY",
            "order_configuration": {
                "limit_limit_gtc": {
                    "base_size": "1000",
                    "limit_price": "0.10",
                    "post_only": False,
                },
            },
        }
        entry = app.orders_list_upsert_from_coinbase(
            app.normalize_order(raw_order),
            raw_order=raw_order,
        )

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.00001",
            "base_increment": "0.1",
        }), patch.object(app, "coinbase_advanced_get", side_effect=[
            {"order": raw_order},
            {"order": raw_order},
            HTTPException(status_code=404, detail="missing"),
        ]), patch.object(app, "coinbase_advanced_post", side_effect=[
            {"results": [{"success": True}]},
            {"success": True, "success_response": {"order_id": "new-abc"}},
        ]) as post:
            response = self.edit({
                "original_id": entry["original_id"],
                "price": 0.20,
            })

        self.assertTrue(response["replaced"])
        place_config = post.call_args_list[1].args[1]["order_configuration"]["limit_limit_gtc"]
        # original $ = 1000 * 0.10 = 100 — re-place as quote_size, not coins
        self.assertEqual(place_config["quote_size"], "100.00000")
        self.assertNotIn("base_size", place_config)


    def test_bracket_edit_stamps_tp_and_sl_legs(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "bracket-1",
            "product_id": "FET-USDC",
            "side": "sell",
            "status": "OPEN",
            "price": 0.20,
            "amount": 100,
            "base_size": 100,
            "order_type": "BRACKET",
            "bracket_legs": [
                {"role": "take_profit", "price": 0.20, "amount": 100, "side": "sell"},
                {"role": "stop_loss", "price": 0.18, "amount": 100, "side": "sell"},
            ],
        }, raw_order={
            "order_id": "bracket-1",
            "product_id": "FET-USDC",
            "side": "SELL",
            "status": "OPEN",
            "filled_size": "0",
            "order_type": "BRACKET",
            "order_configuration": {
                "trigger_bracket_gtc": {
                    "base_size": "100",
                    "limit_price": "0.20",
                    "stop_trigger_price": "0.18",
                },
            },
        })
        local_id = entry["original_id"]

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.00001",
            "base_increment": "0.1",
        }), patch.object(app, "coinbase_advanced_post", return_value={
            "success": True,
        }), patch.object(app, "coinbase_advanced_get", return_value={
            "order": {
                "order_id": "bracket-1",
                "product_id": "FET-USDC",
                "side": "SELL",
                "status": "OPEN",
                "filled_size": "0",
                "order_type": "BRACKET",
                "order_configuration": {
                    "trigger_bracket_gtc": {
                        "base_size": "100",
                        "limit_price": "0.20",
                        "stop_trigger_price": "0.18",
                    },
                },
            },
        }):
            moved_sl = self.edit({
                "original_id": local_id,
                "price": 0.20,
                "stop_price": 0.175,
            })
            moved_tp = self.edit({
                "original_id": local_id,
                "price": 0.22,
                "stop_price": 0.175,
            })

        self.assertTrue(moved_sl["success"])
        sl_legs = {leg["role"]: leg for leg in moved_sl["order"]["bracket_legs"]}
        self.assertAlmostEqual(sl_legs["stop_loss"]["price"], 0.175, places=8)
        self.assertAlmostEqual(sl_legs["take_profit"]["price"], 0.20, places=8)

        self.assertTrue(moved_tp["success"])
        tp_legs = {leg["role"]: leg for leg in moved_tp["order"]["bracket_legs"]}
        self.assertAlmostEqual(tp_legs["take_profit"]["price"], 0.22, places=8)
        self.assertAlmostEqual(tp_legs["stop_loss"]["price"], 0.175, places=8)
        self.assertAlmostEqual(moved_tp["order"]["price"], 0.22, places=8)

    def test_partial_fill_edit_sends_total_size_not_remaining(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "sell-partial",
            "product_id": "BTC-USD",
            "side": "sell",
            "status": "OPEN",
            "price": 100,
            "amount": 3,
            "base_size": 3,
            "leaves_quantity": 3,
            "filled_size": 7,
            "total_base_size": 10,
            "order_type": "LIMIT",
        })

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.01",
            "base_increment": "0.1",
        }), patch.object(app, "coinbase_advanced_post", return_value={
            "success": True,
        }) as post, patch.object(app, "coinbase_advanced_get", return_value={
            "order": {
                "order_id": "sell-partial",
                "product_id": "BTC-USD",
                "side": "SELL",
                "status": "OPEN",
                "filled_size": "7",
                "leaves_quantity": "3",
                "order_configuration": {
                    "limit_limit_gtc": {
                        "base_size": "10",
                        "limit_price": "100",
                    },
                },
            },
        }):
            response = self.edit({
                "original_id": entry["original_id"],
                "price": 101,
            })

        self.assertTrue(response["success"])
        self.assertEqual(post.call_args.args[1]["size"], "10.0")

    def test_edit_size_rounds_up_when_floor_would_be_below_filled(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "sell-floor",
            "product_id": "BTC-USD",
            "side": "sell",
            "status": "OPEN",
            "price": 100,
            "amount": 10.0009,
            "base_size": 10.0009,
            "total_base_size": 10.0009,
            "filled_size": 10.0005,
            "order_type": "LIMIT",
        })

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.01",
            "base_increment": "0.001",
        }), patch.object(app, "coinbase_advanced_post", return_value={
            "success": True,
        }) as post, patch.object(app, "coinbase_advanced_get", return_value={
            "order": {
                "order_id": "sell-floor",
                "product_id": "BTC-USD",
                "side": "SELL",
                "status": "OPEN",
                "filled_size": "10.0005",
                "leaves_quantity": "0.0004",
                "order_configuration": {
                    "limit_limit_gtc": {
                        "base_size": "10.0009",
                        "limit_price": "100",
                    },
                },
            },
        }):
            response = self.edit({
                "original_id": entry["original_id"],
                "price": 101,
            })

        self.assertTrue(response["success"])
        self.assertEqual(post.call_args.args[1]["size"], "10.001")

    def test_sell_edit_stamps_pending_new_price_before_coinbase(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "sell-pending-stamp",
            "product_id": "BTC-USD",
            "side": "sell",
            "status": "OPEN",
            "price": 100,
            "amount": 1,
            "base_size": 1,
            "order_type": "LIMIT",
        })
        local_id = entry["original_id"]
        seen = {}

        def post_edit(path, body):
            kept = app.orders_list_find(original_id=local_id)
            seen["status"] = str(kept["status"]).upper()
            seen["price"] = kept["price"]
            seen["previous_price"] = kept["previous_price"]
            self.assertEqual(path, "/api/v3/brokerage/orders/edit")
            return {"success": True}

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.01",
            "base_increment": "0.0001",
        }), patch.object(app, "coinbase_advanced_post", side_effect=post_edit), patch.object(
            app, "coinbase_advanced_get", return_value={
                "order": {
                    "order_id": "sell-pending-stamp",
                    "product_id": "BTC-USD",
                    "side": "SELL",
                    "status": "OPEN",
                    "filled_size": "0",
                    "order_configuration": {
                        "limit_limit_gtc": {
                            "base_size": "1",
                            "limit_price": "100",
                        },
                    },
                },
            },
        ):
            response = self.edit({
                "original_id": local_id,
                "price": 110,
            })

        self.assertEqual(seen["status"], "PENDING")
        self.assertEqual(seen["price"], 110)
        self.assertEqual(seen["previous_price"], 100)
        self.assertTrue(response["success"])
        self.assertEqual(str(response["order"]["status"]).upper(), "OPEN")
        self.assertEqual(response["order"]["price"], 110)
        self.assertNotIn("previous_price", response["order"])
        public = app.order_public_view(app.orders_list_find(original_id=local_id))
        self.assertNotIn("previous_price", public)

    def test_sell_edit_retries_previous_price_then_opens(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "sell-retry",
            "product_id": "BTC-USD",
            "side": "sell",
            "status": "OPEN",
            "price": 100,
            "amount": 1,
            "base_size": 1,
            "order_type": "LIMIT",
        })
        local_id = entry["original_id"]

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.01",
            "base_increment": "0.0001",
        }), patch.object(app, "coinbase_advanced_post", side_effect=[
            {"success": False, "error_response": "rejected"},
            {"success": True},
        ]) as post, patch.object(app, "coinbase_advanced_get", return_value={
            "order": {
                "order_id": "sell-retry",
                "product_id": "BTC-USD",
                "side": "SELL",
                "status": "OPEN",
                "filled_size": "0",
                "order_configuration": {
                    "limit_limit_gtc": {
                        "base_size": "1",
                        "limit_price": "100",
                    },
                },
            },
        }):
            response = self.edit({
                "original_id": local_id,
                "price": 110,
            })

        self.assertEqual(len(post.call_args_list), 2)
        self.assertEqual(post.call_args_list[0].args[1]["price"], "110.00")
        self.assertEqual(post.call_args_list[1].args[1]["price"], "100.00")
        self.assertTrue(response["success"])
        self.assertEqual(str(response["order"]["status"]).upper(), "OPEN")
        self.assertEqual(response["order"]["price"], 100)

    def test_sell_pending_is_not_overwritten_by_coinbase_snapshot(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "sell-snap",
            "product_id": "BTC-USD",
            "side": "sell",
            "status": "OPEN",
            "price": 100,
            "amount": 1,
            "order_type": "LIMIT",
        })
        local_id = entry["original_id"]
        app.orders_list_set_pending(local_id, 110)

        snapshot = app.orders_list_upsert_from_coinbase({
            "id": "sell-snap",
            "original_id": local_id,
            "product_id": "BTC-USD",
            "side": "sell",
            "status": "OPEN",
            "price": 100,
            "amount": 1,
            "order_type": "LIMIT",
        })
        kept = app.orders_list_find(original_id=local_id)
        self.assertEqual(str(kept["status"]).upper(), "PENDING")
        self.assertEqual(kept["price"], 110)
        self.assertEqual(snapshot["price"], 110)

    def test_sell_edit_both_coinbase_edits_fail_sets_error(self):
        entry = app.orders_list_upsert_from_coinbase({
            "id": "sell-error",
            "product_id": "BTC-USD",
            "side": "sell",
            "status": "OPEN",
            "price": 100,
            "amount": 1,
            "base_size": 1,
            "order_type": "LIMIT",
        })
        local_id = entry["original_id"]

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.01",
            "base_increment": "0.0001",
        }), patch.object(app, "coinbase_advanced_post", return_value={
            "success": False,
        }), patch.object(app, "coinbase_advanced_get", return_value={
            "order": {
                "order_id": "sell-error",
                "product_id": "BTC-USD",
                "side": "SELL",
                "status": "OPEN",
                "filled_size": "0",
                "order_configuration": {
                    "limit_limit_gtc": {
                        "base_size": "1",
                        "limit_price": "100",
                    },
                },
            },
        }):
            with self.assertRaises(HTTPException) as err:
                self.edit({
                    "original_id": local_id,
                    "price": 110,
                })

        self.assertEqual(err.exception.status_code, 400)
        kept = app.orders_list_find(original_id=local_id)
        self.assertEqual(str(kept["status"]).upper(), "ERROR")
        self.assertEqual(kept["price"], 110)


if __name__ == "__main__":
    unittest.main()
