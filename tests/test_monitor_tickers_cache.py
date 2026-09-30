import unittest
from unittest.mock import patch

import app


class MonitorTickersCacheTests(unittest.TestCase):
	def setUp(self):
		with app.monitor_tickers_cache_lock:
			app.monitor_tickers_cache["time"] = 0.0
			app.monitor_tickers_cache["payload"] = None

	def test_monitor_tickers_reuse_cache_within_ttl(self):
		ticker = {
			"currency": "BTC",
			"product_id": "BTC-USD",
			"price": 1.0,
			"open_24h": 1.0,
			"change_24h": 0.0,
			"error": None,
		}

		with patch.object(app, "MONITOR_TICKERS", ["BTC", "ETH"]), patch.object(
			app,
			"fetch_monitor_ticker",
			side_effect=[ticker, {**ticker, "currency": "ETH", "product_id": "ETH-USD"}]
				+ [Exception("should not refetch")] * 4,
		) as fetch:
			first = app.get_cached_monitor_tickers_payload()
			second = app.get_cached_monitor_tickers_payload()

		self.assertEqual(first, second)
		self.assertEqual(fetch.call_count, 2)
		self.assertEqual(len(first["tickers"]), 2)
		self.assertEqual(first["refresh_seconds"], app.MONITOR_TICKERS_CACHE_SECONDS)


if __name__ == "__main__":
	unittest.main()
