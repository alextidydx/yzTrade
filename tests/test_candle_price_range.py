import unittest

import app


class CandlePriceRangeTests(unittest.TestCase):
    def test_builds_range_from_full_candle_set(self):
        candles = [
            {"time": 1, "low": 10.0, "high": 12.0},
            {"time": 2, "low": 8.0, "high": 15.0},
            {"time": 3, "low": 9.0, "high": 11.0},
        ]

        price_range = app.build_candle_price_range(candles)

        self.assertEqual(price_range["min_price"], 7.09)
        self.assertEqual(price_range["max_price"], 15.91)


if __name__ == "__main__":
    unittest.main()
