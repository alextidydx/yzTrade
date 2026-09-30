from concurrent.futures import ThreadPoolExecutor
import threading
import time
import unittest
from unittest.mock import patch

import app


class AccountCacheTests(unittest.TestCase):
	def setUp(self):
		app.clear_account_caches()

	def test_balances_reuse_cache_within_ttl(self):
		payload = {
			"total_usd": 1.0,
			"priced_total": 1,
			"unpriced_total": 0,
			"balances": [{"currency": "USD"}],
		}

		with patch.object(
			app,
			"fetch_balances",
			side_effect=[payload, Exception("should not refetch")],
		) as fetch:
			first = app.get_cached_balances()
			second = app.get_cached_balances()

		self.assertEqual(first, second)
		self.assertEqual(fetch.call_count, 1)

	def test_balances_force_prices_bypasses_cache(self):
		cached = {
			"total_usd": 1.0,
			"priced_total": 1,
			"unpriced_total": 0,
			"balances": [{"currency": "USD"}],
		}
		forced = {
			"total_usd": 2.0,
			"priced_total": 1,
			"unpriced_total": 0,
			"balances": [{"currency": "USDC"}],
		}

		with patch.object(app, "fetch_balances", side_effect=[cached, forced]) as fetch:
			first = app.get_cached_balances()
			second = app.get_cached_balances(force_prices=True)

		self.assertEqual(first, cached)
		self.assertEqual(second, forced)
		self.assertEqual(fetch.call_count, 2)
		self.assertEqual(fetch.call_args_list[1].kwargs.get("force_prices"), True)

	def test_concurrent_forced_balances_share_one_refresh(self):
		payload = {
			"total_usd": 2.0,
			"priced_total": 1,
			"unpriced_total": 0,
			"balances": [{"currency": "USDC"}],
		}
		fetch_started = threading.Event()
		release_fetch = threading.Event()

		def fetch_balances(*, force_prices):
			fetch_started.set()
			release_fetch.wait(timeout=2)
			return payload

		with patch.object(app, "fetch_balances", side_effect=fetch_balances) as fetch:
			with ThreadPoolExecutor(max_workers=2) as executor:
				first = executor.submit(app.get_cached_balances, True)
				self.assertTrue(fetch_started.wait(timeout=1))
				second = executor.submit(app.get_cached_balances, True)
				time.sleep(0.05)
				release_fetch.set()

				self.assertEqual(first.result(timeout=1), payload)
				self.assertEqual(second.result(timeout=1), payload)

		self.assertEqual(fetch.call_count, 1)

	def test_open_orders_reuse_cache_within_ttl(self):
		raw = [{"order_id": "1"}]

		with patch.object(
			app,
			"fetch_open_orders_raw",
			side_effect=[raw, Exception("should not refetch")],
		) as fetch:
			first = app.get_cached_open_orders_raw()
			second = app.get_cached_open_orders_raw()

		self.assertEqual(first, second)
		self.assertEqual(fetch.call_count, 1)

	def test_open_orders_force_bypasses_cache(self):
		cached = [{"order_id": "1"}]
		forced = [{"order_id": "2"}]

		with patch.object(
			app,
			"fetch_open_orders_raw",
			side_effect=[cached, forced],
		) as fetch:
			first = app.get_cached_open_orders_raw()
			second = app.get_cached_open_orders_raw(force=True)

		self.assertEqual(first, cached)
		self.assertEqual(second, forced)
		self.assertEqual(fetch.call_count, 2)

	def test_concurrent_forced_orders_share_one_refresh(self):
		raw = [{"order_id": "2"}]
		fetch_started = threading.Event()
		release_fetch = threading.Event()

		def fetch_orders():
			fetch_started.set()
			release_fetch.wait(timeout=2)
			return raw

		with patch.object(app, "fetch_open_orders_raw", side_effect=fetch_orders) as fetch:
			with ThreadPoolExecutor(max_workers=2) as executor:
				first = executor.submit(app.get_cached_open_orders_raw, True)
				self.assertTrue(fetch_started.wait(timeout=1))
				second = executor.submit(app.get_cached_open_orders_raw, True)
				time.sleep(0.05)
				release_fetch.set()

				self.assertEqual(first.result(timeout=1), raw)
				self.assertEqual(second.result(timeout=1), raw)

		self.assertEqual(fetch.call_count, 1)


if __name__ == "__main__":
	unittest.main()
