import unittest
from unittest.mock import patch

import app


class BalanceForcePricesTests(unittest.TestCase):
    def test_force_prices_clears_cache_and_refetches_ticker(self):
        with app.usd_price_cache_lock:
            app.usd_price_cache["PENGU"] = {
                "price": 0.01,
                "time": app.time.monotonic(),
            }

        with patch.object(app, "coinbase_get", return_value={"price": "0.02"}) as ticker:
            price = app.get_usd_price_for_currency("PENGU", force=True)

        self.assertEqual(price, 0.02)
        ticker.assert_called_once_with("/products/PENGU-USD/ticker")

    def test_cached_price_used_without_force(self):
        with app.usd_price_cache_lock:
            app.usd_price_cache["PENGU"] = {
                "price": 0.01,
                "time": app.time.monotonic(),
            }

        with patch.object(app, "coinbase_get") as ticker:
            price = app.get_usd_price_for_currency("PENGU")

        self.assertEqual(price, 0.01)
        ticker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
