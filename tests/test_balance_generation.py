import asyncio
import unittest

import app


class BalanceGenerationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_run_coinbase_call = app.run_coinbase_call
        self.original_generation = app.balance_generation
        self.original_event_ids = set(app.processed_balance_event_ids)
        self.original_event_queue = list(app.processed_balance_event_id_queue)
        app.balance_generation = 0
        app.processed_balance_event_ids = set()
        app.processed_balance_event_id_queue = []

    async def asyncTearDown(self):
        app.run_coinbase_call = self.original_run_coinbase_call
        app.balance_generation = self.original_generation
        app.processed_balance_event_ids = self.original_event_ids
        app.processed_balance_event_id_queue = self.original_event_queue

    def test_duplicate_order_event_keeps_generation(self):
        first = app.register_balance_order_event("same-event")
        duplicate = app.register_balance_order_event("same-event")
        changed = app.register_balance_order_event("changed-event")

        self.assertEqual(first, 1)
        self.assertEqual(duplicate, 1)
        self.assertEqual(changed, 2)

    def test_pending_status_does_not_refresh_balances(self):
        self.assertIsNone(app.get_balance_refresh_mode_for_order_status("PENDING"))
        self.assertIsNone(app.get_balance_refresh_mode_for_order_status("queued"))
        self.assertEqual(app.get_balance_refresh_mode_for_order_status("OPEN"), "immediate")
        self.assertEqual(
            app.get_balance_refresh_mode_for_order_status("PARTIALLY_FILLED"),
            "debounced",
        )
        self.assertEqual(app.get_balance_refresh_mode_for_order_status("FILLED"), "immediate")
        self.assertEqual(app.get_balance_refresh_mode_for_order_status("CANCELLED"), "immediate")

    async def test_same_generation_requests_fetch_separately(self):
        calls = 0
        release = asyncio.Event()
        first_started = asyncio.Event()
        second_started = asyncio.Event()

        async def fake_run_coinbase_call(*_args):
            nonlocal calls
            calls += 1

            if calls == 1:
                first_started.set()
            elif calls == 2:
                second_started.set()

            await release.wait()
            return {"balances": []}

        app.run_coinbase_call = fake_run_coinbase_call
        app.balance_generation = 1

        first_request = asyncio.create_task(app.get_balances(generation=1))
        second_request = asyncio.create_task(app.get_balances(generation=1))
        await first_started.wait()
        await second_started.wait()

        self.assertEqual(calls, 2)

        release.set()
        first_result, second_result = await asyncio.gather(
            first_request,
            second_request,
        )

        self.assertEqual(first_result["generation"], 1)
        self.assertEqual(second_result["generation"], 1)


if __name__ == "__main__":
    unittest.main()
