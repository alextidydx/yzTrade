import unittest
from unittest.mock import patch

import app


class TrailingOrderTests(unittest.TestCase):
    def setUp(self):
        with app.trailing_orders_lock:
            app._trailing_market_orders.clear()
            app._trailing_limit_by_coinbase_id.clear()
        with app._orders_list_lock:
            app._orders_list.clear()

    def create_order(self, market_price=100, order_type="TRAILING_MARKET"):
        with patch.object(app, "get_product_ticker_price", return_value=market_price), patch.object(
            app,
            "get_product_metadata",
            return_value={"quote_increment": "0.01", "base_increment": "0.000001"},
        ), patch.object(app, "coinbase_advanced_post", return_value={
            "success": True,
            "success_response": {"order_id": "coinbase-stop-1"},
        }):
            return app.create_trailing_order({
                "product_id": "BTC-USD",
                "side": "SELL",
                "order_type": order_type,
                "base_size": 0.25,
                "trail_percent": 5,
            })

    def test_create_keeps_market_in_memory(self):
        order = self.create_order()
        stored = app.get_trailing_orders()

        self.assertEqual(len(stored), 1)
        self.assertEqual(order["order_type"], "TRAILING_MARKET")
        self.assertEqual(order["highest_price"], 100)
        self.assertEqual(order["stop_price"], 95)
        self.assertEqual(stored[0]["id"], order["original_id"])
        self.assertNotIn("id", order)
        self.assertNotIn("coinbase_order_id", order)

    def test_stop_only_moves_up_and_triggers_on_retrace(self):
        order = self.create_order()

        self.assertEqual(app.update_trailing_orders_for_price("BTC-USD", 120), [])
        raised = app.get_trailing_orders()[0]
        self.assertEqual(raised["highest_price"], 120)
        self.assertEqual(raised["stop_price"], 114)

        self.assertEqual(app.update_trailing_orders_for_price("BTC-USD", 116), [])
        unchanged = app.get_trailing_orders()[0]
        self.assertEqual(unchanged["highest_price"], 120)
        self.assertEqual(unchanged["stop_price"], 114)

        triggered = app.update_trailing_orders_for_price("BTC-USD", 114)
        self.assertEqual(len(triggered), 1)
        self.assertEqual(triggered[0]["id"], order["original_id"])
        self.assertEqual(triggered[0]["status"], "TRIGGERING")

    def test_trigger_submits_market_sell_with_stable_client_id(self):
        self.create_order(order_type="TRAILING_MARKET")
        triggered = app.update_trailing_orders_for_price("BTC-USD", 95)[0]

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.01",
            "base_increment": "0.000001",
        }), patch.object(app, "coinbase_advanced_post", return_value={
            "success": True,
            "success_response": {"order_id": "coinbase-order-1"},
        }) as post:
            app.execute_trailing_order(triggered)

        body = post.call_args.args[1]
        self.assertEqual(body["side"], "SELL")
        self.assertEqual(
            body["order_configuration"]["market_market_ioc"]["base_size"],
            "0.250000",
        )
        self.assertEqual(body["client_order_id"], triggered["trigger_client_order_id"])
        self.assertEqual(app.get_trailing_orders(), [])

    def test_trailing_limit_is_placed_as_coinbase_stop_limit(self):
        with patch.object(app, "get_product_ticker_price", return_value=100), patch.object(
            app,
            "get_product_metadata",
            return_value={
                "quote_increment": "0.01",
                "base_increment": "0.000001",
            },
        ), patch.object(app, "coinbase_advanced_post", return_value={
            "success": True,
            "success_response": {"order_id": "coinbase-stop-1"},
        }) as post:
            order = app.create_trailing_order({
                "product_id": "BTC-USD",
                "side": "SELL",
                "order_type": "TRAILING_LIMIT",
                "base_size": 0.25,
                "trail_percent": 5,
            })

        body = post.call_args.args[1]
        config = body["order_configuration"]["stop_limit_stop_limit_gtc"]
        self.assertEqual(body["side"], "SELL")
        self.assertEqual(config["base_size"], "0.250000")
        self.assertEqual(config["stop_price"], "95.00")
        self.assertEqual(config["limit_price"], "95.00")
        self.assertNotIn("coinbase_order_id", order)
        self.assertNotIn("id", order)
        self.assertTrue(str(order["original_id"]).startswith("order-"))
        self.assertEqual(order["order_type"], "TRAILING_LIMIT")
        self.assertEqual(app.get_trailing_orders(), [])
        self.assertIn("coinbase-stop-1", app._trailing_limit_by_coinbase_id)
        tracked = app.orders_list_find(coinbase_id="coinbase-stop-1")
        self.assertIsNotNone(tracked)
        self.assertEqual(str(tracked["order_type"]).upper(), "TRAILING_LIMIT")

    def test_trailing_limit_edits_upward_and_does_not_trigger_locally(self):
        self.create_order(order_type="TRAILING_LIMIT")

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.01",
            "base_increment": "0.000001",
        }), patch.object(app, "coinbase_advanced_post", return_value={
            "success": True,
        }) as post:
            self.assertEqual(app.update_trailing_orders_for_price("BTC-USD", 120), [])

        endpoint = post.call_args.args[0]
        body = post.call_args.args[1]
        self.assertEqual(endpoint, "/api/v3/brokerage/orders/edit")
        self.assertEqual(body["price"], "114.00")
        self.assertEqual(body["stop_price"], "114.00")
        self.assertEqual(body["size"], "0.250000")
        self.assertEqual(app.update_trailing_orders_for_price("BTC-USD", 114), [])
        state = app._trailing_limit_by_coinbase_id["coinbase-stop-1"]
        self.assertEqual(state["highest_price"], 120)
        self.assertEqual(state["stop_price"], 114)

    def test_legacy_trailing_order_migrates_to_market(self):
        normalized = app.normalize_trailing_order({
            "id": "trailing-old",
            "product_id": "BTC-USD",
            "order_type": "TRAILING",
            "base_size": 0.25,
            "trail_percent": 5,
            "highest_price": 100,
            "stop_price": 95,
            "status": "OPEN",
        })

        self.assertEqual(normalized["order_type"], "TRAILING_MARKET")

    def test_trailing_limit_preview_uses_initial_stop_as_limit(self):
        with patch.object(app, "get_product_ticker_price", return_value=100), patch.object(
            app,
            "get_product_metadata",
            return_value={
                "quote_increment": "0.01",
                "base_increment": "0.000001",
            },
        ), patch.object(app, "coinbase_advanced_post", return_value={
            "preview_id": "preview-limit",
            "base_size": "0.25",
        }) as post:
            response = app.preview_order.__wrapped__({
                "product_id": "BTC-USD",
                "side": "SELL",
                "order_type": "TRAILING_LIMIT",
                "base_size": 0.25,
                "trail_percent": 5,
            })

        config = post.call_args.args[1]["order_configuration"]["stop_limit_stop_limit_gtc"]
        self.assertEqual(config["limit_price"], "95.00")
        self.assertEqual(config["stop_price"], "95.00")
        self.assertEqual(config["base_size"], "0.250000")
        self.assertEqual(response["synthetic_order_type"], "TRAILING_LIMIT")

    def test_create_keeps_usdc_product(self):
        with patch.object(app, "get_product_ticker_price", return_value=1.25) as ticker:
            order = app.create_trailing_order({
                "product_id": "PENGU-USDC",
                "side": "SELL",
                "order_type": "TRAILING_MARKET",
                "base_size": 100,
                "trail_percent": 1,
            })

        self.assertEqual(order["product_id"], "PENGU-USDC")
        self.assertEqual(ticker.call_args.args[0], "PENGU-USDC")
        self.assertEqual(app.get_trailing_orders()[0]["product_id"], "PENGU-USDC")

    def test_trigger_keeps_usdc_on_market_sell(self):
        with patch.object(app, "get_product_ticker_price", return_value=1.25):
            order = app.create_trailing_order({
                "product_id": "PENGU-USDC",
                "side": "SELL",
                "order_type": "TRAILING_MARKET",
                "base_size": 100,
                "trail_percent": 1,
            })

        triggered = app.update_trailing_orders_for_price("PENGU-USDC", 1.0)[0]

        with patch.object(app, "get_product_metadata", return_value={
            "quote_increment": "0.000001",
            "base_increment": "1",
        }), patch.object(app, "coinbase_advanced_post", return_value={
            "success": True,
            "success_response": {"order_id": "coinbase-order-usdc"},
        }) as post:
            app.execute_trailing_order(triggered)

        body = post.call_args.args[1]
        self.assertEqual(body["product_id"], "PENGU-USDC")
        self.assertEqual(body["client_order_id"], triggered["trigger_client_order_id"])
        self.assertEqual(order["product_id"], "PENGU-USDC")

    def test_normalize_exchange_product_id_maps_usdc_for_ticker_only(self):
        self.assertEqual(app.normalize_exchange_product_id("pengu-usdc"), "PENGU-USD")
        self.assertEqual(app.normalize_exchange_product_id("PENGU-USD"), "PENGU-USD")
        self.assertEqual(app.normalize_trade_product_id("pengu-usdc"), "PENGU-USDC")

    def test_trailing_executor_is_per_coin_and_not_coinbase_pool(self):
        first = app.get_trailing_executor("PENGU-USD")
        second = app.get_trailing_executor("BTC-USD")
        same = app.get_trailing_executor("pengu-usdc")

        self.assertIsNot(first, second)
        self.assertIs(first, same)
        for executor in app.COINBASE_EXECUTORS.values():
            self.assertIsNot(first, executor)
            self.assertIsNot(second, executor)
        self.assertEqual(app.TRAILING_MONITOR_INTERVAL_SECONDS, 2)

        app.shutdown_trailing_executors()

    def test_cancel_removes_market_from_open_list(self):
        order = self.create_order()

        cancelled = app.cancel_trailing_order(order["original_id"])

        self.assertEqual(cancelled["status"], "CANCELLED")
        self.assertEqual(app.get_trailing_orders(), [])

    def test_cancel_trailing_limit_cancels_coinbase_order(self):
        order = self.create_order(order_type="TRAILING_LIMIT")

        with patch.object(app, "coinbase_advanced_post", return_value={
            "results": [{"success": True}],
        }) as post:
            cancelled = app.cancel_trailing_order(order["original_id"])

        self.assertEqual(
            post.call_args.args,
            (
                "/api/v3/brokerage/orders/batch_cancel",
                {"order_ids": ["coinbase-stop-1"]},
            ),
        )
        self.assertEqual(cancelled["status"], "CANCELLED")
        self.assertEqual(app._trailing_limit_by_coinbase_id, {})
        self.assertIsNone(app.orders_list_find(coinbase_id="coinbase-stop-1"))

    def test_filled_coinbase_stop_is_removed(self):
        order = self.create_order(order_type="TRAILING_LIMIT")

        with patch.object(app, "coinbase_advanced_get", return_value={
            "order": {
                "order_id": "coinbase-stop-1",
                "status": "FILLED",
            },
        }), patch.object(app, "clear_account_caches") as clear_caches:
            changed = app.sync_trailing_limit_fills("BTC-USD")

        self.assertEqual(len(changed), 1)
        self.assertEqual(changed[0]["coinbase_status"], "FILLED")
        self.assertEqual(app._trailing_limit_by_coinbase_id, {})
        self.assertIsNone(app.orders_list_find(coinbase_id="coinbase-stop-1"))
        clear_caches.assert_called_once_with()

    def test_manual_edit_resyncs_trailing_limit_memory(self):
        order = self.create_order(order_type="TRAILING_LIMIT")
        coinbase_id = "coinbase-stop-1"

        updated = app.sync_trailing_limit_after_manual_edit(
            coinbase_id,
            stop_price=90,
        )

        self.assertEqual(updated["stop_price"], 90)
        self.assertAlmostEqual(updated["highest_price"], 90 / 0.95)
        self.assertEqual(
            app._trailing_limit_by_coinbase_id[coinbase_id]["stop_price"],
            90,
        )


if __name__ == "__main__":
    unittest.main()
