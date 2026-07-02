import unittest
from unittest.mock import patch

import app


class NormalizeOrderTests(unittest.TestCase):
    def test_sell_limit_uses_config_base_size(self):
        normalized = app.normalize_order({
            "order_id": "sell-1",
            "product_id": "BTC-USD",
            "side": "SELL",
            "status": "OPEN",
            "filled_size": "0",
            "order_configuration": {
                "limit_limit_gtc": {
                    "base_size": "0.5",
                    "limit_price": "50000",
                },
            },
        })

        self.assertEqual(normalized["amount"], 0.5)
        self.assertEqual(normalized["base_size"], 0.5)

    def test_quote_buy_with_zero_leaves_uses_quote_size_for_total_base(self):
        normalized = app.normalize_order({
            "order_id": "buy-1",
            "product_id": "BTC-USD",
            "side": "BUY",
            "status": "OPEN",
            "filled_size": "0",
            "leaves_quantity": "0",
            "total_fees": "0.15",
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "100",
                    "limit_price": "50000",
                },
            },
        })

        self.assertIsNone(normalized["base_size"])
        self.assertEqual(normalized["total_base_size"], 0.002)
        self.assertEqual(normalized["amount"], 0.002)
        self.assertEqual(normalized["quote_size"], 100)
        self.assertEqual(normalized["order_total"], 100.15)
        self.assertEqual(normalized["filled_percent"], 0)

    def test_quote_buy_partial_fill_uses_filled_plus_leaves_for_utilization(self):
        normalized = app.normalize_order({
            "order_id": "buy-3",
            "product_id": "BTC-USD",
            "side": "BUY",
            "status": "OPEN",
            "filled_size": "0.0008",
            "leaves_quantity": "0.0012",
            "total_fees": "0.15",
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "100",
                    "limit_price": "50000",
                },
            },
        })

        self.assertIsNone(normalized["base_size"])
        self.assertEqual(normalized["total_base_size"], 0.002)
        self.assertEqual(normalized["amount"], 0.0012)
        self.assertEqual(normalized["filled_percent"], 40)

    def test_fill_order_sizes_from_preview_uses_coinbase_base_size(self):
        normalized = app.normalize_order({
            "order_id": "buy-2",
            "product_id": "BTC-USD",
            "side": "BUY",
            "status": "OPEN",
            "filled_size": "0",
            "order_configuration": {
                "limit_limit_gtc": {
                    "quote_size": "100",
                    "limit_price": "50000",
                },
            },
        })

        preview_response = {
            "base_size": "0.00199",
            "order_total": "100.15",
            "commission_total": "0.15",
            "quote_size": "100",
        }

        with patch.object(app, "coinbase_advanced_post", return_value=preview_response):
            enriched = app.fill_order_sizes_from_preview(normalized, {
                "product_id": "BTC-USD",
                "side": "BUY",
                "order_configuration": {
                    "limit_limit_gtc": {
                        "quote_size": "100",
                        "limit_price": "50000",
                    },
                },
            })

        self.assertEqual(enriched["amount"], 0.00199)
        self.assertEqual(enriched["base_size"], 0.00199)
        self.assertEqual(enriched["order_total"], 100.15)
        self.assertEqual(enriched["commission_total"], 0.15)


if __name__ == "__main__":
    unittest.main()
