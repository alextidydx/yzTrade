import asyncio
import threading
import unittest
from unittest.mock import patch

from fastapi.responses import FileResponse

import app


class CoinbaseIsolationTests(unittest.IsolatedAsyncioTestCase):
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
