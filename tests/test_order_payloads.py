import unittest
from unittest.mock import patch

from fastapi import HTTPException

import app


def fake_product_metadata(product_id):
    if str(product_id).upper().startswith("PENGU-"):
        return {
            "quote_increment": "0.000001",
            "base_increment": "1",
        }

    return {
        "quote_increment": "0.01",
        "base_increment": "0.000001",
    }


class OrderPayloadTests(unittest.TestCase):
    def build(self, order):
        with patch.object(app, "get_product_metadata", fake_product_metadata):
            return app.build_coinbase_order_request(order)["body"]

    def test_buy_limit_uses_quote_size_not_base_size(self):
        body = self.build({
            "product_id": "ICP-USDC",
            "side": "BUY",
            "order_type": "LIMIT",
            "quote_size": 1,
            "limit_price": 2.2588042511879824,
        })

        config = body["order_configuration"]["limit_limit_gtc"]

        self.assertEqual(body["side"], "BUY")
        self.assertEqual(body["product_id"], "ICP-USDC")
        self.assertEqual(config["quote_size"], "1.00")
        self.assertNotIn("base_size", config)
        self.assertEqual(config["limit_price"], "2.25")

    def test_sell_limit_uses_base_size_not_quote_size(self):
        body = self.build({
            "product_id": "ICP-USDC",
            "side": "SELL",
            "order_type": "LIMIT",
            "base_size": 0.3675539720438622,
            "limit_price": 2.720688867649251,
        })

        config = body["order_configuration"]["limit_limit_gtc"]

        self.assertEqual(body["side"], "SELL")
        self.assertEqual(config["base_size"], "0.367553")
        self.assertNotIn("quote_size", config)
        self.assertEqual(config["limit_price"], "2.72")

    def test_market_buy_has_no_price(self):
        body = self.build({
            "product_id": "ICP-USDC",
            "side": "BUY",
            "order_type": "MARKET",
            "quote_size": 1,
            "limit_price": 2.72,
            "stop_price": 2.60,
        })

        config = body["order_configuration"]["market_market_ioc"]

        self.assertEqual(config, {"quote_size": "1.00"})

    def test_market_sell_has_no_price(self):
        body = self.build({
            "product_id": "ICP-USDC",
            "side": "SELL",
            "order_type": "MARKET",
            "base_size": 2.123456789,
            "limit_price": 2.72,
        })

        config = body["order_configuration"]["market_market_ioc"]

        self.assertEqual(config, {"base_size": "2.123456"})

    def test_sell_stop_limit_uses_stop_direction_down(self):
        body = self.build({
            "product_id": "ICP-USDC",
            "side": "SELL",
            "order_type": "STOP_LIMIT",
            "base_size": 2,
            "limit_price": 2.70,
            "stop_price": 2.60,
        })

        config = body["order_configuration"]["stop_limit_stop_limit_gtc"]

        self.assertEqual(config["base_size"], "2.000000")
        self.assertEqual(config["limit_price"], "2.70")
        self.assertEqual(config["stop_price"], "2.60")
        self.assertEqual(config["stop_direction"], "STOP_DIRECTION_STOP_DOWN")

    def test_sell_bracket_uses_take_profit_and_stop_loss_fields(self):
        body = self.build({
            "product_id": "PENGU-USDC",
            "side": "SELL",
            "order_type": "BRACKET",
            "base_size": 100,
            "take_profit_price": 0.008808,
            "stop_loss_price": 0.007403,
        })

        config = body["order_configuration"]["trigger_bracket_gtc"]

        self.assertEqual(config["base_size"], "100")
        self.assertEqual(config["limit_price"], "0.008808")
        self.assertEqual(config["stop_trigger_price"], "0.007403")

    def test_buy_bracket_is_rejected(self):
        with patch.object(app, "get_product_metadata", fake_product_metadata):
            with self.assertRaises(HTTPException) as raised:
                app.build_coinbase_order_request({
                    "product_id": "PENGU-USDC",
                    "side": "BUY",
                    "order_type": "BRACKET",
                    "base_size": 100,
                    "take_profit_price": 0.008808,
                    "stop_loss_price": 0.007403,
                })

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("Bracket is only enabled for SELL", raised.exception.detail)


if __name__ == "__main__":
    unittest.main()
