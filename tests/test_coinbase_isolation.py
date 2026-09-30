import asyncio
import threading
import unittest
from unittest.mock import patch

from fastapi.responses import FileResponse

import app


class CoinbaseIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_coinbase_work_uses_independent_execution_lanes(self):
        lane_names = {}

        async def capture(lane):
            lane_names[lane] = await app.run_coinbase_call(
                lambda: threading.current_thread().name,
                _lane=lane,
            )

        await asyncio.gather(*(
            capture(lane)
            for lane in ("interactive", "balances", "orders", "avg-entry", "market")
        ))

        self.assertEqual(len({
            id(app.get_coinbase_executor(lane))
            for lane in lane_names
        }), len(lane_names))
        self.assertTrue(lane_names["interactive"].startswith("coinbase-trade"))
        self.assertTrue(lane_names["balances"].startswith("coinbase-balances"))
        self.assertTrue(lane_names["orders"].startswith("coinbase-orders"))
        self.assertTrue(lane_names["avg-entry"].startswith("coinbase-avg"))
        self.assertTrue(lane_names["market"].startswith("coinbase-market"))

    async def test_identical_calls_share_one_inflight_worker(self):
        started = threading.Event()
        release = threading.Event()
        calls = 0

        def blocked_call():
            nonlocal calls
            calls += 1
            started.set()
            release.wait(timeout=2)
            return {"ok": True}

        first = asyncio.create_task(app.run_coinbase_singleflight(
            ("test", "same"),
            blocked_call,
            _lane="balances",
        ))
        await asyncio.wait_for(asyncio.to_thread(started.wait, 1), timeout=1.5)
        second = asyncio.create_task(app.run_coinbase_singleflight(
            ("test", "same"),
            blocked_call,
            _lane="balances",
        ))
        await asyncio.sleep(0)
        release.set()

        first_result, second_result = await asyncio.gather(first, second)
        self.assertEqual(first_result, second_result)
        self.assertEqual(calls, 1)

    async def test_frontend_responds_while_coinbase_worker_is_blocked(self):
        started = threading.Event()
        release = threading.Event()
        worker_names = []

        def blocked_candle_fetch(*_args):
            worker_names.append(threading.current_thread().name)
            started.set()
            release.wait(timeout=2)
            return []

        with patch.object(app, "fetch_coinbase_candles", blocked_candle_fetch):
            coinbase_task = asyncio.create_task(app.get_candles(
                product_id="BTC-USD",
                days=5,
                granularity=300,
                end_time=None,
                limit=300,
            ))

            try:
                did_start = await asyncio.wait_for(
                    asyncio.to_thread(started.wait, 1),
                    timeout=1.5,
                )
                self.assertTrue(did_start)

                response = await asyncio.wait_for(
                    app.get_frontend(),
                    timeout=0.2,
                )

                self.assertIsInstance(response, FileResponse)
                self.assertTrue(worker_names[0].startswith("coinbase"))
            finally:
                release.set()
                await coinbase_task


if __name__ == "__main__":
    unittest.main()
