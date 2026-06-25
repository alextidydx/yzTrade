import os
import tempfile
import unittest
from unittest.mock import patch

import app


class BalanceHistoryTests(unittest.TestCase):
    def with_history_file(self):
        temp_dir = tempfile.TemporaryDirectory()
        history_path = os.path.join(temp_dir.name, "balance_history.json")
        patcher = patch.object(app, "BALANCE_HISTORY_FILE", history_path)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(temp_dir.cleanup)
        return history_path

    def test_hourly_bucket_records_one_point_per_hour(self):
        self.with_history_file()
        hour = 1_700_000_000
        hour_bucket = (hour // app.BALANCE_HISTORY_BUCKET_SECONDS) * app.BALANCE_HISTORY_BUCKET_SECONDS

        with patch.object(app.time, "time", return_value=hour + 120):
            first = app.record_balance_history_point(1000.0)
            second = app.record_balance_history_point(1100.0)

        self.assertEqual(len(first), 1)
        self.assertEqual(len(second), 1)
        self.assertEqual(first[0]["time"], hour_bucket)
        self.assertEqual(first[0]["total_usd"], 1000.0)

    def test_new_hour_appends_second_point(self):
        self.with_history_file()
        first_hour = 1_700_000_000
        second_hour = first_hour + app.BALANCE_HISTORY_BUCKET_SECONDS

        with patch.object(app.time, "time", return_value=first_hour + 60):
            app.record_balance_history_point(1000.0)

        with patch.object(app.time, "time", return_value=second_hour + 60):
            history = app.record_balance_history_point(1100.0)

        self.assertEqual(len(history), 2)
        self.assertEqual(history[-1]["total_usd"], 1100.0)

    def test_prunes_points_older_than_five_years(self):
        now = 1_800_000_000
        cutoff = now - app.BALANCE_HISTORY_RETENTION_SECONDS
        history = app.normalize_balance_history([
            {"time": cutoff - 1, "total_usd": 10.0},
            {"time": cutoff, "total_usd": 20.0},
            {"time": now, "total_usd": 30.0},
        ], now=now)

        self.assertEqual(
            history,
            [
                {"time": cutoff, "total_usd": 20.0},
                {"time": now, "total_usd": 30.0},
            ],
        )


if __name__ == "__main__":
    unittest.main()
