from datetime import datetime, timedelta, timezone
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from decimal import Decimal, ROUND_DOWN, ROUND_UP, InvalidOperation
from functools import partial, wraps
import hashlib
import json
import math
import os
import secrets
import shutil
import ssl
import tempfile
from threading import Lock, Thread
import time
from typing import Annotated, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import Body, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


COINBASE_API = "https://api.exchange.coinbase.com"
COINBASE_ADVANCED_API = "https://api.coinbase.com"
COINBASE_ADVANCED_HOST = "api.coinbase.com"
COINBASE_WS_API = "wss://advanced-trade-ws.coinbase.com"
COINBASE_USER_WS_API = "wss://advanced-trade-ws-user.coinbase.com"
PRODUCT_ID = os.getenv("COINBASE_PRODUCT_ID", "BTC-USD")
CANDLE_REQUEST_LIMIT = 300
DEPTH_CHART_PADDING_RATIO = 0.09
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "public")
INDEX_HTML = os.path.join(PUBLIC_DIR, "index.html")
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
APP_STATE_FILE = os.getenv("APP_STATE_FILE", os.path.join(DATA_DIR, "app_state.json"))
APP_STATE_FILE_LOCK = Lock()
AVG_ENTRIES_FILE = os.getenv("AVG_ENTRIES_FILE", os.path.join(DATA_DIR, "avg_entries.json"))
AVG_ENTRIES_FILE_LOCK = Lock()
BALANCE_HISTORY_FILE = os.getenv("BALANCE_HISTORY_FILE", os.path.join(DATA_DIR, "balance_history.json"))
def get_balance_history_backup_file():
    return f"{BALANCE_HISTORY_FILE}.bak"


def get_balance_history_error_file():
    return f"{BALANCE_HISTORY_FILE}.error"
BALANCE_HISTORY_BUCKET_SECONDS = 60 * 60
BALANCE_HISTORY_RETENTION_SECONDS = 5 * 365 * 24 * 60 * 60
DEFAULT_APP_STATE = {
    "version": 1,
    "yzTrade": {
        "bookmarks": {},
        "settings": {
            "balanceHistoryColored": True,
            "balanceHistoryExpanded": False,
            "balanceHistoryPeriod": "week",
        },
    },
}
DEFAULT_AVG_ENTRIES = {}
USD_PEGGED_CURRENCIES = {"USD", "USDC", "USDT", "DAI", "PYUSD"}
AVG_ENTRY_DUST_USD = 1.0
AVG_ENTRY_FILL_PAGE_LIMIT = 100
AVG_ENTRY_FILL_MAX_PAGES = 30
BALANCE_HISTORY_PERIODS = {"day", "week", "30d", "all"}
PRE_CONFIRMATION_ORDER_STATUSES = {"PENDING", "QUEUED"}
DEFAULT_MONITOR_TICKERS = [
    "BTC",
    "ETH",
    "ICP",
    "PENGU",
    "XLM",
    "ADA",
    "CRV",
    "ALGO",
    "PENDLE",
    "GFI",
    "NMR",
    "FET",
    "AAVE",
    "XRP",
    "SUI",
    "DOGE",
    "PEPE",
    "FIL",
    "TAO",
    "SOL",
    "ZEC",
    "LTC",
    "SEI",
    "BONK",
]


def parse_monitor_tickers(value):
    tickers = [
        item.strip().upper()
        for item in str(value or "").replace(";", ",").split(",")
        if item.strip()
    ]

    return tickers or DEFAULT_MONITOR_TICKERS


def normalize_balance_history_period(period, default="week"):
    normalized = str(period or default).strip().lower()

    return normalized if normalized in BALANCE_HISTORY_PERIODS else default


def get_default_app_state():
    return json.loads(json.dumps(DEFAULT_APP_STATE))


def normalize_app_state(raw_state):
    state = raw_state if isinstance(raw_state, dict) else {}
    normalized = get_default_app_state()

    for key, value in state.items():
        if key not in normalized:
            normalized[key] = value

    yztrade = state.get("yzTrade")
    if isinstance(yztrade, dict):
        normalized["yzTrade"].update(yztrade)

    bookmarks = normalized["yzTrade"].get("bookmarks")
    if not isinstance(bookmarks, dict):
        bookmarks = {}

    settings = normalized["yzTrade"].get("settings")
    if not isinstance(settings, dict):
        settings = {}

    normalized_bookmarks = {}
    for currency, price in bookmarks.items():
        normalized_currency = str(currency or "").strip().upper()

        try:
            numeric_price = float(price)
        except (TypeError, ValueError):
            continue

        if normalized_currency and math.isfinite(numeric_price):
            normalized_bookmarks[normalized_currency] = numeric_price

    normalized["version"] = int(normalized.get("version") or DEFAULT_APP_STATE["version"])
    normalized["yzTrade"]["bookmarks"] = normalized_bookmarks
    # Avg entries live in avg_entries.json — never persist them in app_state.
    normalized["yzTrade"].pop("avgEntries", None)
    normalized["yzTrade"].pop("avgEntryNullDates", None)
    normalized["yzTrade"]["settings"] = {
        **DEFAULT_APP_STATE["yzTrade"]["settings"],
        **settings,
    }
    normalized["yzTrade"]["settings"]["balanceHistoryExpanded"] = bool(
        normalized["yzTrade"]["settings"].get("balanceHistoryExpanded")
    )
    normalized["yzTrade"]["settings"]["balanceHistoryColored"] = bool(
        normalized["yzTrade"]["settings"].get("balanceHistoryColored")
    )
    normalized["yzTrade"]["settings"]["balanceHistoryPeriod"] = normalize_balance_history_period(
        normalized["yzTrade"]["settings"].get("balanceHistoryPeriod")
    )

    return normalized


def _read_app_state_unlocked():
    if not os.path.exists(APP_STATE_FILE):
        return get_default_app_state()

    try:
        with open(APP_STATE_FILE, "r", encoding="utf-8") as state_file:
            return normalize_app_state(json.load(state_file))
    except (OSError, json.JSONDecodeError):
        # Existing file is unreadable — do not hand back defaults for a write.
        return None


def read_app_state():
    with APP_STATE_FILE_LOCK:
        return _read_app_state_unlocked() or get_default_app_state()


def _write_app_state_unlocked(state):
    normalized = normalize_app_state(state)
    state_dir = os.path.dirname(APP_STATE_FILE)

    if state_dir:
        os.makedirs(state_dir, exist_ok=True)

    fd, temp_path = tempfile.mkstemp(
        prefix=".app_state.",
        suffix=".json",
        dir=state_dir or None,
        text=True,
    )

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as temp_file:
            json.dump(normalized, temp_file, indent=2, sort_keys=True)
            temp_file.write("\n")

        os.replace(temp_path, APP_STATE_FILE)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)

    return normalized


def _mutate_app_state(mutator):
    with APP_STATE_FILE_LOCK:
        state = _read_app_state_unlocked()
        if state is None:
            return None
        mutator(state)
        return _write_app_state_unlocked(state)


def normalize_bookmark_currency(currency):
    normalized = str(currency or "").strip().upper()

    if not normalized or not normalized.replace("-", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid bookmark currency.")

    return normalized.split("-", 1)[0]


def set_app_state_bookmark(currency, price):
    normalized_currency = normalize_bookmark_currency(currency)

    try:
        numeric_price = float(price)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid bookmark price.")

    if not math.isfinite(numeric_price) or numeric_price <= 0:
        raise HTTPException(status_code=400, detail="Invalid bookmark price.")

    def mutator(state):
        state.setdefault("yzTrade", {}).setdefault("bookmarks", {})[normalized_currency] = numeric_price

    return _mutate_app_state(mutator)


def delete_app_state_bookmark(currency):
    normalized_currency = normalize_bookmark_currency(currency)

    def mutator(state):
        state.setdefault("yzTrade", {}).setdefault("bookmarks", {}).pop(normalized_currency, None)

    return _mutate_app_state(mutator)


def normalize_avg_entries(raw_entries):
    entries = raw_entries if isinstance(raw_entries, dict) else {}
    normalized = {}

    for currency, raw_entry in entries.items():
        normalized_currency = str(currency or "").strip().upper()
        if not normalized_currency or not isinstance(raw_entry, dict):
            continue

        null_date = str(raw_entry.get("nullDate") or "").strip() or None

        try:
            avg_price = float(raw_entry.get("avgPrice"))
        except (TypeError, ValueError):
            avg_price = None

        if avg_price is None or not math.isfinite(avg_price) or avg_price <= 0:
            avg_price = None

        try:
            qty = float(raw_entry.get("qty"))
        except (TypeError, ValueError):
            qty = 0.0

        if not math.isfinite(qty) or qty < 0:
            qty = 0.0

        normalized[normalized_currency] = {
            "nullDate": null_date,
            "avgPrice": avg_price,
            "qty": qty,
        }

    return normalized


def _extract_legacy_avg_entries_from_app_state():
    if not os.path.exists(APP_STATE_FILE):
        return {}

    try:
        with open(APP_STATE_FILE, "r", encoding="utf-8") as state_file:
            raw = json.load(state_file)
    except (OSError, json.JSONDecodeError):
        return {}

    yztrade = raw.get("yzTrade") if isinstance(raw, dict) else None
    if not isinstance(yztrade, dict):
        return {}

    entries = yztrade.get("avgEntries")
    if not isinstance(entries, dict):
        entries = {}

    legacy_null_dates = yztrade.get("avgEntryNullDates")
    if isinstance(legacy_null_dates, dict):
        for currency, null_date in legacy_null_dates.items():
            normalized_currency = str(currency or "").strip().upper()
            stamp = str(null_date or "").strip()
            if not normalized_currency or not stamp:
                continue
            existing = entries.get(normalized_currency)
            if not isinstance(existing, dict):
                entries[normalized_currency] = {
                    "nullDate": stamp,
                    "avgPrice": None,
                    "qty": 0.0,
                }
            elif not str(existing.get("nullDate") or "").strip():
                existing["nullDate"] = stamp

    return normalize_avg_entries(entries)


def _write_avg_entries_unlocked(entries):
    normalized = normalize_avg_entries(entries)
    state_dir = os.path.dirname(AVG_ENTRIES_FILE)

    if state_dir:
        os.makedirs(state_dir, exist_ok=True)

    fd, temp_path = tempfile.mkstemp(
        prefix=".avg_entries.",
        suffix=".json",
        dir=state_dir or None,
        text=True,
    )

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as temp_file:
            json.dump(normalized, temp_file, indent=2, sort_keys=True)
            temp_file.write("\n")

        os.replace(temp_path, AVG_ENTRIES_FILE)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)

    return normalized


def _read_avg_entries_unlocked():
    if os.path.exists(AVG_ENTRIES_FILE):
        try:
            with open(AVG_ENTRIES_FILE, "r", encoding="utf-8") as avg_file:
                return normalize_avg_entries(json.load(avg_file))
        except (OSError, json.JSONDecodeError):
            return None

    legacy = _extract_legacy_avg_entries_from_app_state()
    if legacy:
        return _write_avg_entries_unlocked(legacy)

    return dict(DEFAULT_AVG_ENTRIES)


def read_avg_entries():
    with AVG_ENTRIES_FILE_LOCK:
        return _read_avg_entries_unlocked() or dict(DEFAULT_AVG_ENTRIES)


def app_state_payload():
    """Bookmarks/settings from app_state + avgEntries from separate file (API/WS only)."""
    state = read_app_state()
    payload = json.loads(json.dumps(state))
    payload.setdefault("yzTrade", {})["avgEntries"] = read_avg_entries()
    return payload


def get_avg_entry_record(currency):
    normalized_currency = normalize_bookmark_currency(currency)
    entry = read_avg_entries().get(normalized_currency)
    return dict(entry) if isinstance(entry, dict) else None


def set_avg_entry_record(currency, *, null_date=None, avg_price=None, qty=0.0, clear=False):
    normalized_currency = normalize_bookmark_currency(currency)

    with AVG_ENTRIES_FILE_LOCK:
        entries = _read_avg_entries_unlocked()
        if entries is None:
            return None

        if clear:
            entries.pop(normalized_currency, None)
            return _write_avg_entries_unlocked(entries)

        stamp = str(null_date or "").strip() or None

        try:
            numeric_avg = float(avg_price) if avg_price is not None else None
        except (TypeError, ValueError):
            numeric_avg = None

        if numeric_avg is None or not math.isfinite(numeric_avg) or numeric_avg <= 0:
            numeric_avg = None

        try:
            numeric_qty = float(qty)
        except (TypeError, ValueError):
            numeric_qty = 0.0

        if not math.isfinite(numeric_qty) or numeric_qty < 0:
            numeric_qty = 0.0

        if numeric_avg is None and numeric_qty <= 0 and not stamp:
            entries.pop(normalized_currency, None)
        else:
            entries[normalized_currency] = {
                "nullDate": stamp,
                "avgPrice": numeric_avg,
                "qty": numeric_qty,
            }

        return _write_avg_entries_unlocked(entries)


def set_app_state_settings(settings):
    if not isinstance(settings, dict):
        raise HTTPException(status_code=400, detail="Invalid app settings.")

    def mutator(state):
        yztrade = state.setdefault("yzTrade", {})
        current_settings = yztrade.setdefault("settings", {})

        if "balanceHistoryExpanded" in settings:
            current_settings["balanceHistoryExpanded"] = bool(settings.get("balanceHistoryExpanded"))

        if "balanceHistoryColored" in settings:
            current_settings["balanceHistoryColored"] = bool(settings.get("balanceHistoryColored"))

        if "balanceHistoryPeriod" in settings:
            current_settings["balanceHistoryPeriod"] = normalize_balance_history_period(
                settings.get("balanceHistoryPeriod")
            )

    return _mutate_app_state(mutator)


def normalize_balance_history(raw_history, now=None):
    rows = raw_history if isinstance(raw_history, list) else []
    normalized = []
    reference_time = int(now or time.time())
    cutoff_time = reference_time - BALANCE_HISTORY_RETENTION_SECONDS

    for row in rows:
        if not isinstance(row, dict):
            continue

        try:
            point_time = int(row.get("time"))
            total_usd = float(row.get("total_usd"))
        except (TypeError, ValueError):
            continue

        if point_time >= cutoff_time and math.isfinite(total_usd) and total_usd >= 0:
            normalized.append({
                "time": point_time,
                "total_usd": round(total_usd, 2),
            })

    normalized.sort(key=lambda point: point["time"])

    return normalized


def serialize_balance_history(history):
    return [
        {
            "time": point["time"],
            "time_utc": datetime.fromtimestamp(
                point["time"],
                timezone.utc,
            ).strftime("%m/%d/%Y %H:%M"),
            "total_usd": point["total_usd"],
        }
        for point in history
    ]


def load_balance_history_json(path):
    with open(path, "r", encoding="utf-8") as history_file:
        payload = json.load(history_file)

    return payload if isinstance(payload, list) else []


def count_balance_history_points(path):
    if not os.path.exists(path):
        return 0

    try:
        return len(load_balance_history_json(path))
    except (OSError, json.JSONDecodeError):
        return 0


def backup_balance_history_file():
    if not os.path.exists(BALANCE_HISTORY_FILE):
        return

    try:
        shutil.copy2(BALANCE_HISTORY_FILE, get_balance_history_backup_file())
    except OSError as error:
        print(f"BALANCE_HISTORY BACKUP ERROR err={error}", flush=True)


def archive_balance_history_read_error(error):
    if not os.path.exists(BALANCE_HISTORY_FILE):
        return

    try:
        shutil.copy2(BALANCE_HISTORY_FILE, get_balance_history_error_file())
        print(
            "BALANCE_HISTORY READ ERROR archived "
            f"path={get_balance_history_error_file()} err={error}",
            flush=True,
        )
    except OSError as archive_error:
        print(f"BALANCE_HISTORY ERROR ARCHIVE FAILED err={archive_error}", flush=True)


def read_balance_history():
    for path in (BALANCE_HISTORY_FILE, get_balance_history_backup_file()):
        if not os.path.exists(path):
            continue

        try:
            normalized = normalize_balance_history(load_balance_history_json(path))

            if normalized or path == BALANCE_HISTORY_FILE:
                if path == get_balance_history_backup_file() and normalized:
                    print("BALANCE_HISTORY RESTORED from backup file", flush=True)
                    write_balance_history(normalized, allow_shrink=True)

                return normalized
        except (OSError, json.JSONDecodeError) as error:
            print(f"BALANCE_HISTORY READ ERROR path={path} err={error}", flush=True)
            if path == BALANCE_HISTORY_FILE:
                archive_balance_history_read_error(error)

    return []


def write_balance_history(history, allow_shrink=False):
    normalized = normalize_balance_history(history)
    existing_point_count = max(
        count_balance_history_points(BALANCE_HISTORY_FILE),
        count_balance_history_points(get_balance_history_backup_file()),
    )

    if (
        not allow_shrink
        and existing_point_count >= 2
        and len(normalized) < existing_point_count
    ):
        print(
            "BALANCE_HISTORY WRITE BLOCKED "
            f"existing={existing_point_count} next={len(normalized)}",
            flush=True,
        )
        return read_balance_history()

    history_dir = os.path.dirname(BALANCE_HISTORY_FILE)

    if history_dir:
        os.makedirs(history_dir, exist_ok=True)

    backup_balance_history_file()

    fd, temp_path = tempfile.mkstemp(
        prefix=".balance_history.",
        suffix=".json",
        dir=history_dir or None,
        text=True,
    )

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as temp_file:
            json.dump(serialize_balance_history(normalized), temp_file, indent=2, sort_keys=True)
            temp_file.write("\n")

        os.replace(temp_path, BALANCE_HISTORY_FILE)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)

    return normalized


def record_balance_history_point(total_usd):
    try:
        numeric_total = float(total_usd)
    except (TypeError, ValueError):
        return read_balance_history()

    if not math.isfinite(numeric_total) or numeric_total < 0:
        return read_balance_history()

    now = int(time.time())
    bucket_time = (now // BALANCE_HISTORY_BUCKET_SECONDS) * BALANCE_HISTORY_BUCKET_SECONDS
    history = read_balance_history()

    if (
        not history
        and os.path.exists(BALANCE_HISTORY_FILE)
        and os.path.getsize(BALANCE_HISTORY_FILE) > 10
    ):
        print(
            "BALANCE_HISTORY WARN refusing write after empty read "
            f"file_bytes={os.path.getsize(BALANCE_HISTORY_FILE)}",
            flush=True,
        )
        return history

    if any(point["time"] == bucket_time for point in history):
        return history

    history.append({
        "time": bucket_time,
        "total_usd": round(numeric_total, 2),
    })

    return write_balance_history(history)


def filter_balance_history(period):
    history = read_balance_history()
    normalized_period = str(period or "all").lower()

    period_seconds = {
        "day": 24 * 60 * 60,
        "week": 7 * 24 * 60 * 60,
        "30d": 30 * 24 * 60 * 60,
        "all": None,
    }.get(normalized_period, None)

    if period_seconds is None or not history:
        return history

    cutoff = int(time.time()) - period_seconds
    filtered = [point for point in history if point["time"] >= cutoff]

    return filtered or history[:1]


def load_env_file():
    env_path = os.path.join(os.path.dirname(__file__), ".env")

    if not os.path.exists(env_path):
        return

    with open(env_path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()

            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'").replace("\\n", "\n")

            if key and key not in os.environ:
                os.environ[key] = value


load_env_file()
MONITOR_TICKERS = parse_monitor_tickers(os.getenv("MONITOR_TICKERS"))
PRODUCT_ID = os.getenv("COINBASE_PRODUCT_ID") or f"{MONITOR_TICKERS[0]}-USD"
APP_HOST = os.getenv("APP_HOST", "0.0.0.0")
APP_PORT = int(os.getenv("APP_PORT", "5003"))
APP_RELOAD = os.getenv("APP_RELOAD", "true").strip().lower() in {"1", "true", "yes", "on"}


@asynccontextmanager
async def app_lifespan(_app):
    global trailing_monitor_task

    if trailing_monitor_task is None or trailing_monitor_task.done():
        trailing_monitor_task = asyncio.create_task(monitor_trailing_orders())

    try:
        yield
    finally:
        if trailing_monitor_task is not None:
            trailing_monitor_task.cancel()

            try:
                await trailing_monitor_task
            except asyncio.CancelledError:
                pass

            trailing_monitor_task = None

        shutdown_trailing_executors()


app = FastAPI(lifespan=app_lifespan)
COINBASE_EXECUTORS = {
    # Trading can never sit behind account refreshes or chart polling.
    "interactive": ThreadPoolExecutor(max_workers=16, thread_name_prefix="coinbase-trade"),
    # Each polling category has independent capacity.
    "balances": ThreadPoolExecutor(max_workers=16, thread_name_prefix="coinbase-balances"),
    "orders": ThreadPoolExecutor(max_workers=16, thread_name_prefix="coinbase-orders"),
    "avg-entry": ThreadPoolExecutor(max_workers=32, thread_name_prefix="coinbase-avg"),
    # Public market data is isolated from authenticated account work.
    "market": ThreadPoolExecutor(max_workers=64, thread_name_prefix="coinbase-market"),
}
coinbase_singleflight_tasks = {}
coinbase_singleflight_lock = asyncio.Lock()
live_client_count = 0
live_ws_clients = set()
live_ws_clients_lock = Lock()
live_ws_loop = None
app_state_clients = set()
app_state_lock = asyncio.Lock()
balance_generation = 0
processed_balance_event_ids = set()
processed_balance_event_id_queue = []
usd_price_cache = {}
usd_price_cache_lock = Lock()
APP_STATE_HEARTBEAT_SECONDS = 10
COINBASE_LIVE_STALE_SECONDS = 25
COINBASE_DEPTH_WS_MAX_SIZE = 16 * 1024 * 1024
USD_PRICE_CACHE_SECONDS = 60
MONITOR_TICKERS_CACHE_SECONDS = 60
BALANCES_CACHE_SECONDS = 15
ORDERS_CACHE_SECONDS = 15
monitor_tickers_cache = {
	"time": 0.0,
	"payload": None,
}
monitor_tickers_cache_lock = Lock()
monitor_tickers_refresh_lock = Lock()
balances_cache = {
	"time": 0.0,
	"force_generation": 0,
	"payload": None,
}
balances_cache_lock = Lock()
balances_refresh_lock = Lock()
orders_cache = {
	"time": 0.0,
	"force_generation": 0,
	"raw_orders": None,
}
orders_cache_lock = Lock()
orders_refresh_lock = Lock()
BALANCE_EVENT_ID_CACHE_SIZE = 200
TRAILING_MONITOR_INTERVAL_SECONDS = 2
TRAILING_TICKER_TIMEOUT_SECONDS = 5
TRAILING_TICKER_RETRIES = 3
TRAILING_TICKER_RETRY_BACKOFF_SECONDS = 0.25
TRAILING_EXECUTOR_MAX_PRODUCTS = 32
trailing_orders_lock = Lock()
# TRAILING_MARKET only — Coinbase has no native trailing market.
_trailing_market_orders: list = []
# TRAILING_LIMIT trail meta keyed by Coinbase stop-limit id (no file).
_trailing_limit_by_coinbase_id: dict = {}
_orders_list_lock = Lock()
_orders_list: list = []
trailing_executors_lock = Lock()
trailing_executors = {}
trailing_monitor_task = None
coinbase_signing_key = None
coinbase_signing_key_fingerprint = None
coinbase_signing_key_lock = Lock()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_coinbase_executor(lane):
    executor = COINBASE_EXECUTORS.get(lane)

    if executor is None:
        raise ValueError(f"Unknown Coinbase execution lane: {lane}")

    return executor


async def run_coinbase_call(func, *args, _lane="market", **kwargs):
    loop = asyncio.get_running_loop()

    return await loop.run_in_executor(
        get_coinbase_executor(_lane),
        partial(func, *args, **kwargs),
    )


async def run_coinbase_singleflight(key, func, *args, _lane="avg-entry", **kwargs):
    """Let concurrent identical requests await one worker operation."""
    async with coinbase_singleflight_lock:
        task = coinbase_singleflight_tasks.get(key)

        if task is None or task.done():
            task = asyncio.create_task(
                run_coinbase_call(func, *args, _lane=_lane, **kwargs)
            )
            coinbase_singleflight_tasks[key] = task

    try:
        return await asyncio.shield(task)
    finally:
        if task.done():
            async with coinbase_singleflight_lock:
                if coinbase_singleflight_tasks.get(key) is task:
                    coinbase_singleflight_tasks.pop(key, None)


def get_trailing_executor(product_id):
    normalized_product_id = normalize_exchange_product_id(product_id) or "UNKNOWN"

    with trailing_executors_lock:
        executor = trailing_executors.get(normalized_product_id)

        if executor is not None:
            return executor

        if len(trailing_executors) >= TRAILING_EXECUTOR_MAX_PRODUCTS:
            overflow = trailing_executors.get("__overflow__")

            if overflow is None:
                overflow = ThreadPoolExecutor(
                    max_workers=2,
                    thread_name_prefix="trail-overflow",
                )
                trailing_executors["__overflow__"] = overflow

            return overflow

        executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix=f"trail-{normalized_product_id}",
        )
        trailing_executors[normalized_product_id] = executor
        return executor


def prune_trailing_executors(active_product_ids):
    active = {
        normalize_exchange_product_id(product_id)
        for product_id in active_product_ids
        if product_id
    }
    active.add("__overflow__")

    with trailing_executors_lock:
        stale_ids = [
            product_id
            for product_id in trailing_executors
            if product_id not in active
        ]

        for product_id in stale_ids:
            trailing_executors.pop(product_id).shutdown(wait=False)


def shutdown_trailing_executors():
    with trailing_executors_lock:
        executors = list(trailing_executors.values())
        trailing_executors.clear()

    for executor in executors:
        executor.shutdown(wait=False)


async def run_trailing_call(product_id, func, *args, **kwargs):
    loop = asyncio.get_running_loop()

    return await loop.run_in_executor(
        get_trailing_executor(product_id),
        partial(func, *args, **kwargs),
    )


def process_trailing_trigger(order):
    try:
        execute_trailing_order(order)
    except HTTPException as exc:
        print(
            f"TRAILING EXECUTE SKIP order={order.get('id')} "
            f"status={exc.status_code} detail={exc.detail}",
            flush=True,
        )


def process_trailing_product(product_id):
    sync_trailing_limit_fills(product_id)

    try:
        market_price = get_product_ticker_price(product_id)
    except HTTPException as exc:
        print(
            f"TRAILING TICKER SKIP product={product_id} "
            f"status={exc.status_code} detail={exc.detail}",
            flush=True,
        )
        return

    triggered = update_trailing_orders_for_price(product_id, market_price)

    for order in triggered:
        process_trailing_trigger(order)


def register_balance_order_event(event_id):
    global balance_generation

    normalized_event_id = str(event_id or "").strip()

    if normalized_event_id and normalized_event_id in processed_balance_event_ids:
        return balance_generation

    if normalized_event_id:
        processed_balance_event_ids.add(normalized_event_id)
        processed_balance_event_id_queue.append(normalized_event_id)

        if len(processed_balance_event_id_queue) > BALANCE_EVENT_ID_CACHE_SIZE:
            expired_event_id = processed_balance_event_id_queue.pop(0)
            processed_balance_event_ids.discard(expired_event_id)

    balance_generation += 1
    clear_balances_cache()
    clear_orders_cache()
    return balance_generation


def coinbase_worker_endpoint(func=None, *, lane="market"):
    def decorate(endpoint):
        @wraps(endpoint)
        async def wrapped(*args, **kwargs):
            return await run_coinbase_call(
                endpoint,
                *args,
                _lane=lane,
                **kwargs,
            )

        return wrapped

    if func is None:
        return decorate

    return decorate(func)


async def monitor_trailing_orders():
    while True:
        try:
            active_orders = get_trailing_market_orders()
            triggering_orders = [
                order
                for order in active_orders
                if str(order.get("status") or "").upper() == "TRIGGERING"
            ]
            product_ids = sorted({
                *(
                    order["product_id"]
                    for order in active_orders
                    if str(order.get("status") or "").upper() == "OPEN"
                ),
                *trailing_limit_product_ids(),
            })
            tasks = [
                run_trailing_call(order.get("product_id"), process_trailing_trigger, order)
                for order in triggering_orders
            ]
            tasks.extend(
                run_trailing_call(product_id, process_trailing_product, product_id)
                for product_id in product_ids
            )

            if tasks:
                results = await asyncio.gather(*tasks, return_exceptions=True)

                for result in results:
                    if isinstance(result, Exception) and not isinstance(result, HTTPException):
                        print(f"TRAILING MONITOR TASK ERROR error={result}", flush=True)

            prune_trailing_executors(
                [order.get("product_id") for order in active_orders]
                + product_ids
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"TRAILING MONITOR ERROR error={exc}", flush=True)

        await asyncio.sleep(TRAILING_MONITOR_INTERVAL_SECONDS)


if os.path.isdir(os.path.join(PUBLIC_DIR, "assets")):
    app.mount(
        "/assets",
        StaticFiles(directory=os.path.join(PUBLIC_DIR, "assets")),
        name="assets",
    )
    app.mount(
        "/trade/assets",
        StaticFiles(directory=os.path.join(PUBLIC_DIR, "assets")),
        name="trade-assets",
    )


def coinbase_get(path, params=None, timeout=15):
    query = f"?{urlencode(params)}" if params else ""
    request = Request(
        f"{COINBASE_API}{path}{query}",
        headers={
            "Accept": "application/json",
            "User-Agent": "yzTrade/1.0",
        },
    )

    context = None
    try:
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        context = ssl.create_default_context()

    try:
        with urlopen(request, timeout=timeout, context=context) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8") or exc.reason
        raise HTTPException(status_code=exc.code, detail=detail)
    except (URLError, TimeoutError) as exc:
        raise HTTPException(status_code=502, detail=f"Coinbase request failed: {exc}")


def get_ssl_context():
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def get_coinbase_signing_key(api_secret):
    global coinbase_signing_key
    global coinbase_signing_key_fingerprint

    fingerprint = hashlib.sha256(api_secret.encode("utf-8")).digest()

    with coinbase_signing_key_lock:
        if (
            coinbase_signing_key is not None
            and coinbase_signing_key_fingerprint == fingerprint
        ):
            return coinbase_signing_key

        try:
            private_key = serialization.load_pem_private_key(
                api_secret.encode("utf-8"),
                password=None,
            )
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Unable to load Coinbase JWT signing key: {exc}",
            ) from exc

        if not isinstance(private_key, ec.EllipticCurvePrivateKey):
            raise HTTPException(
                status_code=500,
                detail="Coinbase JWT signing key must be an EC private key.",
            )

        coinbase_signing_key = private_key
        coinbase_signing_key_fingerprint = fingerprint
        return private_key


def build_coinbase_jwt_from_payload(payload):
    api_key = os.getenv("COINBASE_API_KEY")
    api_secret = os.getenv("COINBASE_API_SECRET", "").replace("\\n", "\n")

    if not api_key or not api_secret:
        raise HTTPException(
            status_code=500,
            detail="Coinbase API credentials are missing. Set COINBASE_API_KEY and COINBASE_API_SECRET.",
        )

    def base64_url(data):
        return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")

    def int_to_fixed(raw):
        value = raw.lstrip(b"\x00") or b"\x00"

        if len(value) > 32:
            value = value[-32:]

        return value.rjust(32, b"\x00")

    def der_to_jose(signature):
        offset = 0

        if signature[offset] != 0x30:
            raise ValueError("Invalid ECDSA signature")

        offset += 1
        sequence_length = signature[offset]
        offset += 1

        if sequence_length & 0x80:
            length_bytes = sequence_length & 0x7F
            sequence_length = int.from_bytes(signature[offset:offset + length_bytes], "big")
            offset += length_bytes

        if signature[offset] != 0x02:
            raise ValueError("Invalid ECDSA r marker")

        offset += 1
        r_length = signature[offset]
        offset += 1
        r = signature[offset:offset + r_length]
        offset += r_length

        if signature[offset] != 0x02:
            raise ValueError("Invalid ECDSA s marker")

        offset += 1
        s_length = signature[offset]
        offset += 1
        s = signature[offset:offset + s_length]

        return base64_url(int_to_fixed(r) + int_to_fixed(s))

    now = int(time.time())
    payload = {
        "sub": api_key,
        "iss": "cdp",
        "nbf": now,
        "exp": now + 120,
        **payload,
    }
    signing_input = ".".join([
        base64_url(json.dumps({
            "alg": "ES256",
            "typ": "JWT",
            "kid": api_key,
            "nonce": secrets.token_hex(16),
        }, separators=(",", ":")).encode("utf-8")),
        base64_url(json.dumps(payload, separators=(",", ":")).encode("utf-8")),
    ])

    try:
        signature = get_coinbase_signing_key(api_secret).sign(
            signing_input.encode("utf-8"),
            ec.ECDSA(hashes.SHA256()),
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to sign Coinbase JWT: {exc}",
        ) from exc

    return f"{signing_input}.{der_to_jose(signature)}"


def build_coinbase_jwt(method, path):
    return build_coinbase_jwt_from_payload({
        "uri": f"{method.upper()} {COINBASE_ADVANCED_HOST}{path}",
    })


def build_coinbase_ws_jwt():
    return build_coinbase_jwt_from_payload({})


def coinbase_advanced_request(method, path, params=None, body=None):
    query = f"?{urlencode(params, doseq=True)}" if params else ""
    token = build_coinbase_jwt(method, path)
    data = None
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
            "User-Agent": "yzTrade/1.0",
    }

    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(
        f"{COINBASE_ADVANCED_API}{path}{query}",
        data=data,
        headers=headers,
        method=method.upper(),
    )

    context = None
    try:
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        context = ssl.create_default_context()

    try:
        with urlopen(request, timeout=15, context=context) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8") or exc.reason
        raise HTTPException(status_code=exc.code, detail=detail)
    except (URLError, TimeoutError) as exc:
        raise HTTPException(status_code=502, detail=f"Coinbase authenticated request failed: {exc}")


def coinbase_advanced_get(path, params=None):
    return coinbase_advanced_request("GET", path, params=params)


def coinbase_advanced_post(path, body=None):
    return coinbase_advanced_request("POST", path, body=body)


def parse_order_configuration(order):
    configuration = order.get("order_configuration") or {}

    for config in configuration.values():
        if isinstance(config, dict):
            return config

    return {}


def parse_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_decimal(value):
    try:
        if value is None:
            return None

        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def format_decimal_for_increment(value, increment):
    numeric_value = parse_decimal(value)
    numeric_increment = parse_decimal(increment)

    if numeric_value is None:
        return None

    if numeric_increment is None or numeric_increment <= 0:
        return format(numeric_value.normalize(), "f")

    rounded = numeric_value.quantize(numeric_increment, rounding=ROUND_DOWN)

    return format(rounded, "f")


def get_product_metadata(product_id):
    try:
        return coinbase_advanced_get(f"/api/v3/brokerage/products/{product_id}")
    except HTTPException as exc:
        print(
            f"COINBASE PRODUCT METADATA FAILED product={product_id} status={exc.status_code} detail={exc.detail}",
            flush=True,
        )
        return {}


def parse_balance_value(balance):
    if isinstance(balance, dict):
        return parse_float(balance.get("value"))

    return parse_float(balance)


def clear_usd_price_cache():
    with usd_price_cache_lock:
        usd_price_cache.clear()


def clear_balances_cache():
    with balances_cache_lock:
        balances_cache["time"] = 0.0
        balances_cache["force_generation"] = (
            int(balances_cache.get("force_generation") or 0) + 1
        )
        balances_cache["payload"] = None


def clear_orders_cache():
    with orders_cache_lock:
        orders_cache["time"] = 0.0
        orders_cache["force_generation"] = (
            int(orders_cache.get("force_generation") or 0) + 1
        )
        orders_cache["raw_orders"] = None


def clear_account_caches():
    clear_balances_cache()
    clear_orders_cache()


def get_usd_price_for_currency(currency, force=False):
    normalized_currency = str(currency or "").upper()

    if normalized_currency in USD_PEGGED_CURRENCIES:
        return 1.0

    now = time.monotonic()

    if not force:
        with usd_price_cache_lock:
            cached = usd_price_cache.get(normalized_currency)

        if cached and now - cached["time"] < USD_PRICE_CACHE_SECONDS:
            return cached["price"]

    try:
        ticker = coinbase_get(f"/products/{normalized_currency}-USD/ticker")
    except HTTPException:
        return None

    price = parse_float(ticker.get("price"))

    if price is None or price <= 0:
        return None

    with usd_price_cache_lock:
        usd_price_cache[normalized_currency] = {
            "price": price,
            "time": now,
        }

    return price


def parse_order_price(value):
    price = parse_float(value)

    return price if price is not None and price > 0 else None


def positive_float(value):
    parsed = parse_float(value)

    return parsed if parsed is not None and parsed > 0 else None


def normalize_exchange_product_id(product_id):
    """Map Advanced Trade quote pairs to Exchange ticker products (USDC -> USD)."""
    normalized = str(product_id or "").strip().upper()

    if normalized.endswith("-USDC"):
        return f"{normalized[:-5]}-USD"

    return normalized


def normalize_trade_product_id(product_id):
    """Keep Advanced Trade product as sent (USDC stays USDC)."""
    return str(product_id or "").strip().upper()


TRAILING_ORDER_TYPES = {"TRAILING_MARKET", "TRAILING_LIMIT"}


def normalize_trailing_order_type(order_type):
    normalized = str(order_type or "").strip().upper()

    # Legacy "TRAILING" always meant a synthetic market trail.
    if normalized == "TRAILING":
        return "TRAILING_MARKET"

    return normalized if normalized in TRAILING_ORDER_TYPES else None


def normalize_trailing_market_order(order):
    if not isinstance(order, dict):
        return None

    order_id = str(order.get("id") or "").strip()
    product_id = normalize_trade_product_id(order.get("product_id"))
    base_size = positive_float(order.get("base_size") or order.get("amount"))
    trail_percent = positive_float(order.get("trail_percent"))
    highest_price = positive_float(order.get("highest_price"))
    stop_price = positive_float(order.get("stop_price") or order.get("price"))

    if (
        not order_id
        or not product_id
        or base_size is None
        or trail_percent is None
        or trail_percent >= 100
        or highest_price is None
        or stop_price is None
    ):
        return None

    status = str(order.get("status") or "OPEN").strip().upper()
    if status not in {"OPEN", "TRIGGERING"}:
        return None

    return {
        **order,
        "id": order_id,
        "cancel_id": order_id,
        "product_id": product_id,
        "side": "sell",
        "status": status,
        "order_type": "TRAILING_MARKET",
        "base_size": base_size,
        "total_base_size": base_size,
        "amount": base_size,
        "filled_size": 0,
        "filled_percent": 0,
        "trail_percent": trail_percent,
        "highest_price": highest_price,
        "stop_price": stop_price,
        "price": stop_price,
        "total_value": stop_price * base_size,
        "bracket_legs": [],
        "trigger_client_order_id": str(
            order.get("trigger_client_order_id") or f"trailing-trigger-{order_id}"
        ),
    }


# Back-compat alias for tests / callers.
normalize_trailing_order = normalize_trailing_market_order


def get_trailing_market_orders():
    with trailing_orders_lock:
        return [
            order
            for order in (
                normalize_trailing_market_order(item)
                for item in _trailing_market_orders
            )
            if order is not None
        ]


def get_trailing_orders():
    """Open TRAILING_MARKET rows only (in memory). Limits live in _orders_list."""
    return get_trailing_market_orders()


def trailing_limit_product_ids():
    with trailing_orders_lock:
        return sorted({
            normalize_trade_product_id(state.get("product_id"))
            for state in _trailing_limit_by_coinbase_id.values()
            if state.get("product_id")
        })


def _upsert_trailing_market_unlocked(order):
    normalized = normalize_trailing_market_order(order)
    if normalized is None:
        return None

    for index, current in enumerate(_trailing_market_orders):
        if current.get("id") == normalized["id"]:
            _trailing_market_orders[index] = normalized
            return normalized

    _trailing_market_orders.append(normalized)
    return normalized


def _remove_trailing_market_unlocked(order_id):
    target = str(order_id or "")
    removed = None
    kept = []

    for order in _trailing_market_orders:
        if order.get("id") == target:
            removed = order
            continue
        kept.append(order)

    _trailing_market_orders[:] = kept
    return removed


def purge_trailing_limit_state(coinbase_id):
    target = str(coinbase_id or "").strip()
    if not target:
        return None

    with trailing_orders_lock:
        return _trailing_limit_by_coinbase_id.pop(target, None)


def get_product_ticker_price(
    product_id,
    timeout=TRAILING_TICKER_TIMEOUT_SECONDS,
    retries=TRAILING_TICKER_RETRIES,
):
    exchange_product_id = normalize_exchange_product_id(product_id)
    attempts = max(1, int(retries or 1))
    last_error = None

    for attempt in range(attempts):
        try:
            ticker = coinbase_get(
                f"/products/{exchange_product_id}/ticker",
                timeout=timeout,
            )
            price = positive_float(ticker.get("price"))

            if price is None:
                raise HTTPException(
                    status_code=502,
                    detail=f"Coinbase returned no price for {exchange_product_id}.",
                )

            return price
        except HTTPException as exc:
            last_error = exc

            if attempt + 1 >= attempts:
                break

            time.sleep(TRAILING_TICKER_RETRY_BACKOFF_SECONDS * (attempt + 1))

    if last_error is not None:
        raise last_error

    raise HTTPException(
        status_code=502,
        detail=f"Coinbase returned no price for {exchange_product_id}.",
    )


def build_trailing_market_order_request(order, include_client_order_id=False):
    request = build_coinbase_order_request({
        "product_id": normalize_trade_product_id(order.get("product_id")),
        "side": "SELL",
        "order_type": "MARKET",
        "base_size": order.get("base_size"),
    }, include_client_order_id=include_client_order_id)

    if include_client_order_id:
        request["body"]["client_order_id"] = order.get("trigger_client_order_id")

    return request


def build_trailing_limit_order_request(order, include_client_order_id=False):
    request = build_coinbase_order_request({
        "product_id": normalize_trade_product_id(order.get("product_id")),
        "side": "SELL",
        "order_type": "STOP_LIMIT",
        "base_size": order.get("base_size"),
        "limit_price": order.get("stop_price"),
        "stop_price": order.get("stop_price"),
    }, include_client_order_id=include_client_order_id)

    if include_client_order_id:
        request["body"]["client_order_id"] = order.get("trigger_client_order_id")

    return request


def place_trailing_limit_coinbase_order(order):
    request = build_trailing_limit_order_request(
        order,
        include_client_order_id=True,
    )
    response = coinbase_advanced_post("/api/v3/brokerage/orders", request["body"])

    if response.get("success") is not True:
        raise HTTPException(
            status_code=400,
            detail=(
                response.get("failure_reason")
                or response.get("error_response")
                or "Coinbase rejected the trailing stop-limit sell."
            ),
        )

    coinbase_order_id = (
        (response.get("success_response") or {}).get("order_id")
        or response.get("order_id")
    )

    if not coinbase_order_id:
        raise HTTPException(
            status_code=502,
            detail="Coinbase created no order ID for the trailing stop-limit sell.",
        )

    return str(coinbase_order_id)


def build_trailing_trigger_order_request(order, include_client_order_id=False):
    return build_trailing_market_order_request(
        order,
        include_client_order_id=include_client_order_id,
    )


def _stamp_trailing_limit_on_orders_list(coinbase_id, *, stop_price, trail_percent, highest_price):
    with _orders_list_lock:
        entry = _orders_find_locked(coinbase_id=coinbase_id)
        if entry is None:
            return None

        entry["order_type"] = "TRAILING_LIMIT"
        entry["trail_percent"] = trail_percent
        entry["highest_price"] = highest_price
        entry["stop_price"] = stop_price
        entry["price"] = stop_price
        if positive_float(entry.get("base_size")):
            entry["total_value"] = stop_price * float(entry["base_size"])
        return order_public_view(entry)


def create_trailing_order(order):
    side = str(order.get("side") or "").upper()
    product_id = normalize_trade_product_id(order.get("product_id") or PRODUCT_ID)
    base_size = positive_float(order.get("base_size"))
    trail_percent = positive_float(order.get("trail_percent"))
    order_type = normalize_trailing_order_type(order.get("order_type"))

    if side != "SELL":
        raise HTTPException(status_code=400, detail="Trailing is only enabled for SELL.")
    if base_size is None:
        raise HTTPException(status_code=400, detail="Trailing requires a positive base_size.")
    if trail_percent is None or trail_percent >= 100:
        raise HTTPException(status_code=400, detail="Trail percent must be greater than 0 and below 100.")
    if order_type is None:
        raise HTTPException(status_code=400, detail="Trailing order type is invalid.")

    market_price = get_product_ticker_price(product_id)
    stop_price = market_price * (1 - trail_percent / 100)
    now = datetime.now(timezone.utc).isoformat()

    if order_type == "TRAILING_LIMIT":
        trigger_client_order_id = f"trailing-trigger-{secrets.token_hex(16)}"
        place_seed = {
            "product_id": product_id,
            "base_size": base_size,
            "stop_price": stop_price,
            "trigger_client_order_id": trigger_client_order_id,
        }
        coinbase_order_id = place_trailing_limit_coinbase_order(place_seed)

        normalized = {
            "id": coinbase_order_id,
            "product_id": product_id,
            "side": "sell",
            "status": "OPEN",
            "price": stop_price,
            "stop_price": stop_price,
            "amount": base_size,
            "base_size": base_size,
            "total_base_size": base_size,
            "total_value": stop_price * base_size,
            "order_type": "TRAILING_LIMIT",
            "trail_percent": trail_percent,
            "highest_price": market_price,
            "client_order_id": trigger_client_order_id,
            "bracket_legs": [],
        }
        tracked = orders_list_upsert_from_coinbase(
            normalized,
            place_payload={
                "order_type": "TRAILING_LIMIT",
                "trail_percent": trail_percent,
                "highest_price": market_price,
                "stop_price": stop_price,
                "limit_price": stop_price,
                "base_size": base_size,
            },
        )

        with trailing_orders_lock:
            _trailing_limit_by_coinbase_id[coinbase_order_id] = {
                "coinbase_order_id": coinbase_order_id,
                "product_id": product_id,
                "base_size": base_size,
                "trail_percent": trail_percent,
                "highest_price": market_price,
                "stop_price": stop_price,
                "created_at": now,
                "updated_at": now,
            }

        public = tracked or _stamp_trailing_limit_on_orders_list(
            coinbase_order_id,
            stop_price=stop_price,
            trail_percent=trail_percent,
            highest_price=market_price,
        )
        if public is None:
            raise HTTPException(status_code=500, detail="Unable to track trailing stop-limit.")

        public_order = order_public_view(public) if isinstance(public, dict) else public
        return {
            **public_order,
            "trail_percent": trail_percent,
            "highest_price": market_price,
            "stop_price": stop_price,
            "order_type": "TRAILING_LIMIT",
        }

    order_id = f"trailing-{secrets.token_hex(16)}"
    trailing_order = normalize_trailing_market_order({
        "id": order_id,
        "product_id": product_id,
        "order_type": "TRAILING_MARKET",
        "base_size": base_size,
        "trail_percent": trail_percent,
        "highest_price": market_price,
        "stop_price": stop_price,
        "status": "OPEN",
        "created_at": now,
        "updated_at": now,
        "trigger_client_order_id": f"trailing-trigger-{secrets.token_hex(16)}",
    })

    with trailing_orders_lock:
        _upsert_trailing_market_unlocked(trailing_order)

    return trailing_public_view(trailing_order)


def cancel_trailing_order(order_id):
    target = str(order_id or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="order_id is required.")

    if target.startswith("trailing-"):
        with trailing_orders_lock:
            current = next(
                (order for order in _trailing_market_orders if order.get("id") == target),
                None,
            )
            if current is None:
                raise HTTPException(status_code=404, detail="Trailing order was not found.")

            status = str(current.get("status") or "").upper()
            if status == "TRIGGERING":
                raise HTTPException(
                    status_code=409,
                    detail="Trailing order is already triggering and cannot be cancelled.",
                )
            if status != "OPEN":
                raise HTTPException(status_code=400, detail="Trailing order is no longer open.")

            removed = _remove_trailing_market_unlocked(target)

        public = trailing_public_view(removed or {"id": target, "original_id": target})
        public["status"] = "CANCELLED"
        public["updated_at"] = datetime.now(timezone.utc).isoformat()
        return public

    # Trailing limit = Coinbase stop-limit id (or tracked original that maps to it).
    coinbase_id = target
    tracked = resolve_tracked_entry(target)
    if tracked is not None:
        coinbase_id = tracked_coinbase_id(tracked) or target

    state = None
    with trailing_orders_lock:
        state = _trailing_limit_by_coinbase_id.get(str(coinbase_id))

    if state is None and tracked is None:
        raise HTTPException(status_code=404, detail="Trailing order was not found.")

    if coinbase_id:
        response = coinbase_advanced_post(
            "/api/v3/brokerage/orders/batch_cancel",
            {"order_ids": [coinbase_id]},
        )
        results = response.get("results", [])
        result = results[0] if results else {}

        if not bool(result.get("success")):
            raise HTTPException(
                status_code=400,
                detail=(
                    result.get("failure_reason")
                    or result.get("error_response")
                    or "Coinbase did not cancel the trailing stop-limit order."
                ),
            )

    purge_trailing_limit_state(coinbase_id)
    if tracked is not None:
        orders_list_remove(str(tracked.get("original_id") or ""))
    else:
        orders_list_apply_closed(coinbase_id)

    return {
        "original_id": str((tracked or {}).get("original_id") or target),
        "status": "CANCELLED",
        "order_type": "TRAILING_LIMIT",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def sync_trailing_limit_after_manual_edit(coinbase_id, *, stop_price=None, price=None):
    """Keep in-memory trail state aligned with a user edit so monitor won't yank stop back."""
    target_id = str(coinbase_id or "").strip()
    target_stop = positive_float(stop_price)
    if target_stop is None:
        target_stop = positive_float(price)
    if not target_id or target_stop is None or target_stop <= 0:
        return None

    updated = None
    with trailing_orders_lock:
        state = _trailing_limit_by_coinbase_id.get(target_id)
        if not isinstance(state, dict):
            return None

        trail_percent = float(state.get("trail_percent") or 0)
        if trail_percent > 0 and trail_percent < 100:
            implied_high = target_stop / (1 - trail_percent / 100)
        else:
            implied_high = target_stop

        updated = {
            **state,
            "stop_price": target_stop,
            "highest_price": implied_high,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        _trailing_limit_by_coinbase_id[target_id] = updated

    _stamp_trailing_limit_on_orders_list(
        target_id,
        stop_price=updated["stop_price"],
        trail_percent=updated.get("trail_percent"),
        highest_price=updated["highest_price"],
    )
    return updated


def edit_trailing_limit_coinbase_order(state):
    coinbase_order_id = str(state.get("coinbase_order_id") or "").strip()
    product_id = normalize_trade_product_id(state.get("product_id"))
    base_size = positive_float(state.get("base_size"))
    stop_price = positive_float(state.get("stop_price"))

    if not coinbase_order_id or not product_id or base_size is None or stop_price is None:
        raise HTTPException(status_code=500, detail="Trailing limit order is incomplete.")

    metadata = get_product_metadata(product_id)
    quote_increment = (
        metadata.get("quote_increment")
        or metadata.get("quote_min_size")
        or "0.00000001"
    )
    base_increment = (
        metadata.get("base_increment")
        or metadata.get("base_min_size")
        or "0.00000001"
    )
    body = {
        "order_id": coinbase_order_id,
        "price": format_decimal_for_increment(stop_price, quote_increment),
        "stop_price": format_decimal_for_increment(stop_price, quote_increment),
        "size": format_decimal_for_increment(base_size, base_increment),
    }
    response = coinbase_advanced_post("/api/v3/brokerage/orders/edit", body)

    if response.get("success") is not True:
        raise HTTPException(
            status_code=400,
            detail=(
                response.get("error_response")
                or response.get("failure_reason")
                or response.get("errors")
                or "Coinbase rejected the trailing stop-limit edit."
            ),
        )

    return response


def sync_trailing_limit_fills(product_id):
    """When the Coinbase stop-limit is gone/filled, drop trail state + open-list row."""
    normalized_product_id = normalize_trade_product_id(product_id)
    closed_statuses = {"FILLED", "CANCELLED", "CANCELED", "EXPIRED", "FAILED"}

    with trailing_orders_lock:
        active = [
            dict(state)
            for state in _trailing_limit_by_coinbase_id.values()
            if normalize_trade_product_id(state.get("product_id")) == normalized_product_id
        ]

    removed = []

    for state in active:
        coinbase_order_id = str(state.get("coinbase_order_id") or "")
        if not coinbase_order_id:
            continue

        try:
            response = coinbase_advanced_get(
                f"/api/v3/brokerage/orders/historical/{coinbase_order_id}",
            )
        except HTTPException:
            continue

        raw_order = response.get("order") or response
        coinbase_status = str(raw_order.get("status") or "").upper()

        if coinbase_status not in closed_statuses:
            continue

        purge_trailing_limit_state(coinbase_order_id)
        orders_list_apply_closed(coinbase_order_id)
        removed.append({
            **state,
            "status": coinbase_status,
            "coinbase_status": coinbase_status,
        })

    if removed:
        clear_account_caches()

    return removed


def update_trailing_orders_for_price(product_id, market_price):
    normalized_product_id = normalize_trade_product_id(product_id)
    price = positive_float(market_price)
    triggers = []

    if not normalized_product_id or price is None:
        return triggers

    limit_updates = []

    with trailing_orders_lock:
        for index, order in enumerate(list(_trailing_market_orders)):
            if normalize_trade_product_id(order.get("product_id")) != normalized_product_id:
                continue
            if str(order.get("status") or "").upper() != "OPEN":
                continue

            highest_price = max(float(order["highest_price"]), price)
            stop_price = highest_price * (1 - float(order["trail_percent"]) / 100)
            updated = order

            if highest_price != order["highest_price"] or stop_price != order["stop_price"]:
                updated = normalize_trailing_market_order({
                    **order,
                    "highest_price": highest_price,
                    "stop_price": stop_price,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
                _trailing_market_orders[index] = updated

            if price <= float(updated["stop_price"]):
                updated = normalize_trailing_market_order({
                    **updated,
                    "status": "TRIGGERING",
                    "trigger_price": price,
                    "triggered_at": datetime.now(timezone.utc).isoformat(),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
                _trailing_market_orders[index] = updated
                triggers.append(updated)

        for coinbase_id, state in list(_trailing_limit_by_coinbase_id.items()):
            if normalize_trade_product_id(state.get("product_id")) != normalized_product_id:
                continue

            highest_price = max(float(state["highest_price"]), price)
            stop_price = highest_price * (1 - float(state["trail_percent"]) / 100)

            if highest_price == state["highest_price"] and stop_price == state["stop_price"]:
                continue

            updated = {
                **state,
                "highest_price": highest_price,
                "stop_price": stop_price,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            _trailing_limit_by_coinbase_id[coinbase_id] = updated
            limit_updates.append(updated)

    for updated in limit_updates:
        try:
            edit_trailing_limit_coinbase_order(updated)
        except HTTPException as exc:
            print(
                f"TRAILING LIMIT EDIT FAILED coinbase={updated.get('coinbase_order_id')} "
                f"detail={exc.detail}",
                flush=True,
            )
            continue

        _stamp_trailing_limit_on_orders_list(
            updated["coinbase_order_id"],
            stop_price=updated["stop_price"],
            trail_percent=updated["trail_percent"],
            highest_price=updated["highest_price"],
        )

    return triggers


def execute_trailing_order(order):
    order_id = order.get("id")
    request = build_trailing_trigger_order_request(order, include_client_order_id=True)

    try:
        response = coinbase_advanced_post("/api/v3/brokerage/orders", request["body"])
        if response.get("success") is not True:
            raise HTTPException(
                status_code=400,
                detail=(
                    response.get("failure_reason")
                    or response.get("error_response")
                    or "Coinbase rejected the triggered trailing sell."
                ),
            )
    except HTTPException as exc:
        with trailing_orders_lock:
            for index, current in enumerate(_trailing_market_orders):
                if current.get("id") == order_id and current.get("status") == "TRIGGERING":
                    _trailing_market_orders[index] = normalize_trailing_market_order({
                        **current,
                        "status": "OPEN",
                        "last_error": exc.detail,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    })
                    break
        return None

    with trailing_orders_lock:
        _remove_trailing_market_unlocked(order_id)

    return response



def parse_order_commission_total(order):
    commission_detail = order.get("commission_detail_total")

    if isinstance(commission_detail, dict):
        commission = positive_float(commission_detail.get("total_commission"))

        if commission is not None:
            return commission

    return positive_float(order.get("total_fees"))


def parse_order_base_size(order, config):
    return (
        positive_float(config.get("base_size"))
        or positive_float(order.get("base_size"))
        or positive_float(order.get("size"))
        or positive_float(order.get("workable_size"))
    )


def parse_order_quote_size(order, config):
    return positive_float(config.get("quote_size") or order.get("quote_size"))


def parse_order_gross_total(order, side, quote_size, commission_total):
    order_total = positive_float(order.get("order_total"))

    if order_total is not None:
        return order_total

    total_after_fees = positive_float(order.get("total_value_after_fees"))

    if total_after_fees is not None:
        return total_after_fees

    if quote_size is None:
        return None

    if str(side).lower() == "buy" and commission_total is not None:
        return quote_size + commission_total

    return quote_size


def compute_order_total_base_size(order, numeric_base_size, numeric_filled_size, quote_size, side, numeric_price):
    if numeric_base_size is not None:
        return numeric_base_size

    filled_size = numeric_filled_size if numeric_filled_size is not None else 0
    leaves_quantity = positive_float(order.get("leaves_quantity"))

    if leaves_quantity is not None:
        total_size = filled_size + leaves_quantity

        if total_size > 0:
            return total_size

    if str(side).lower() == "buy" and quote_size is not None and numeric_price:
        return quote_size / numeric_price

    return None


def compute_order_remaining_base_size(order, numeric_base_size, numeric_filled_size):
    leaves_quantity = positive_float(order.get("leaves_quantity"))

    if leaves_quantity is not None:
        return leaves_quantity

    if numeric_base_size is None:
        return None

    filled_size = numeric_filled_size if numeric_filled_size is not None else 0
    remaining_size = numeric_base_size - filled_size

    return remaining_size if remaining_size > 0 else None


def build_preview_request_from_order(raw_order):
    product_id = raw_order.get("product_id")
    side = str(raw_order.get("side") or "").upper()
    configuration = raw_order.get("order_configuration") or {}

    if not product_id or side not in ("BUY", "SELL") or not configuration:
        return None

    return {
        "product_id": product_id,
        "side": side,
        "order_configuration": configuration,
    }


def apply_preview_response_to_order(normalized, preview):
    if not isinstance(normalized, dict) or not isinstance(preview, dict):
        return normalized

    base_size = positive_float(preview.get("base_size"))

    if base_size is not None:
        normalized["amount"] = base_size
        normalized["base_size"] = base_size
        normalized["total_base_size"] = base_size

    order_total = positive_float(preview.get("order_total"))

    if order_total is not None:
        normalized["order_total"] = order_total
        normalized["total_value"] = order_total

    commission_total = positive_float(preview.get("commission_total"))

    if commission_total is not None:
        normalized["commission_total"] = commission_total

    quote_size = positive_float(preview.get("quote_size"))

    if quote_size is not None:
        normalized["quote_size"] = quote_size

    filled_size = parse_float(normalized.get("filled_size"))
    total_base_size = positive_float(normalized.get("total_base_size")) or base_size

    if total_base_size and filled_size is not None:
        normalized["filled_percent"] = max(
            0,
            min(100, (filled_size / total_base_size) * 100),
        )

    return normalized


def apply_preview_snapshot_to_order(normalized, snapshot):
    if not isinstance(normalized, dict) or not isinstance(snapshot, dict):
        return normalized

    return apply_preview_response_to_order(normalized, {
        "base_size": snapshot.get("preview_base_size") or snapshot.get("base_size"),
        "order_total": snapshot.get("preview_order_total") or snapshot.get("order_total"),
        "commission_total": snapshot.get("preview_commission_total") or snapshot.get("commission_total"),
        "quote_size": snapshot.get("preview_quote_size") or snapshot.get("quote_size"),
    })


def fill_order_sizes_from_preview(normalized, raw_order):
    if not isinstance(normalized, dict):
        return normalized

    if positive_float(normalized.get("base_size")) is not None:
        return normalized

    preview_request = build_preview_request_from_order(raw_order)

    if preview_request is None:
        return normalized

    try:
        preview = coinbase_advanced_post("/api/v3/brokerage/orders/preview", preview_request)
    except HTTPException:
        return normalized

    return apply_preview_response_to_order(normalized, preview)


def build_coinbase_order_request(order, include_client_order_id=True):
    product_id = str(order.get("product_id") or PRODUCT_ID).upper()
    side = str(order.get("side") or "").upper()
    order_type = str(order.get("order_type") or "").upper()
    base_size = parse_float(order.get("base_size"))
    quote_size = parse_float(order.get("quote_size"))
    limit_price = parse_order_price(order.get("limit_price"))
    stop_price = parse_order_price(order.get("stop_price"))
    take_profit_price = parse_order_price(order.get("take_profit_price"))
    stop_loss_price = parse_order_price(order.get("stop_loss_price"))
    product_metadata = get_product_metadata(product_id)
    quote_increment = (
        product_metadata.get("quote_increment")
        or product_metadata.get("quote_min_size")
        or "0.00000001"
    )
    base_increment = (
        product_metadata.get("base_increment")
        or product_metadata.get("base_min_size")
        or "0.00000001"
    )
    formatted_base_size = format_decimal_for_increment(base_size, base_increment)
    formatted_quote_size = format_decimal_for_increment(quote_size, quote_increment)
    formatted_limit_price = format_decimal_for_increment(limit_price, quote_increment)
    formatted_stop_price = format_decimal_for_increment(stop_price, quote_increment)
    formatted_take_profit_price = format_decimal_for_increment(take_profit_price, quote_increment)
    formatted_stop_loss_price = format_decimal_for_increment(stop_loss_price, quote_increment)

    if side not in ("BUY", "SELL"):
        raise HTTPException(status_code=400, detail="side must be BUY or SELL.")

    if order_type not in ("LIMIT", "MARKET", "STOP_LIMIT", "BRACKET"):
        raise HTTPException(status_code=400, detail="Unsupported order type.")

    if base_size is not None and base_size <= 0:
        raise HTTPException(status_code=400, detail="base_size must be positive.")

    if quote_size is not None and quote_size <= 0:
        raise HTTPException(status_code=400, detail="quote_size must be positive.")

    if order_type == "MARKET":
        if quote_size is None and base_size is None:
            raise HTTPException(status_code=400, detail="Market order requires quote_size or base_size.")

        market_config = {}

        if quote_size is not None:
            market_config["quote_size"] = formatted_quote_size
        else:
            market_config["base_size"] = formatted_base_size

        order_configuration = {
            "market_market_ioc": market_config,
        }
    elif order_type == "LIMIT":
        if base_size is None and quote_size is None:
            raise HTTPException(status_code=400, detail="Limit order requires base_size or quote_size.")

        if limit_price is None:
            raise HTTPException(status_code=400, detail="Limit order requires limit_price.")

        limit_config = {
            "limit_price": formatted_limit_price,
            "post_only": False,
        }

        if quote_size is not None:
            limit_config["quote_size"] = formatted_quote_size
        else:
            limit_config["base_size"] = formatted_base_size

        order_configuration = {
            "limit_limit_gtc": limit_config,
        }
    elif order_type == "STOP_LIMIT":
        if limit_price is None or stop_price is None:
            raise HTTPException(
                status_code=400,
                detail="Stop limit requires base_size or quote_size, limit_price, and stop_price.",
            )

        if base_size is None and quote_size is not None and limit_price > 0:
            base_size = quote_size / limit_price
            formatted_base_size = format_decimal_for_increment(base_size, base_increment)

        if base_size is None:
            raise HTTPException(
                status_code=400,
                detail="Stop limit requires base_size or quote_size, limit_price, and stop_price.",
            )

        order_configuration = {
            "stop_limit_stop_limit_gtc": {
                "base_size": formatted_base_size,
                "limit_price": formatted_limit_price,
                "stop_price": formatted_stop_price,
                "stop_direction": "STOP_DIRECTION_STOP_DOWN" if side == "SELL" else "STOP_DIRECTION_STOP_UP",
            },
        }
    else:
        if side != "SELL":
            raise HTTPException(status_code=400, detail="Bracket is only enabled for SELL in this app.")
        if base_size is None or take_profit_price is None or stop_loss_price is None:
            raise HTTPException(status_code=400, detail="Bracket requires base_size, take_profit_price, and stop_loss_price.")
        order_configuration = {
            "trigger_bracket_gtc": {
                "base_size": formatted_base_size,
                "limit_price": formatted_take_profit_price,
                "stop_trigger_price": formatted_stop_loss_price,
            },
        }

    body = {
        "product_id": product_id,
        "side": side,
        "order_configuration": order_configuration,
    }

    if include_client_order_id:
        body["client_order_id"] = (
            str(order.get("client_order_id") or "").strip()
            or secrets.token_hex(16)
        )

    preview_id = str(order.get("preview_id") or "").strip()

    if include_client_order_id and preview_id:
        body["preview_id"] = preview_id

    return {
        "body": body,
        "product_id": product_id,
        "side": side,
        "order_type": order_type,
        "order_configuration": order_configuration,
    }


def normalize_order(order):
    order_configuration = order.get("order_configuration") or {}
    bracket_config = order_configuration.get("trigger_bracket_gtc")
    config = bracket_config if isinstance(bracket_config, dict) else parse_order_configuration(order)
    price = (
        config.get("limit_price")
        or config.get("stop_price")
        or order.get("limit_price")
        or order.get("stop_price")
    )
    filled_size = order.get("filled_size") or order.get("cumulative_quantity") or "0"
    numeric_price = parse_order_price(price)

    if numeric_price is None:
        return None

    numeric_filled_size = parse_float(filled_size)
    numeric_base_size = parse_order_base_size(order, config)
    quote_size = parse_order_quote_size(order, config)
    order_id = order.get("order_id")
    side = str(order.get("side") or order.get("order_side") or "").lower()
    commission_total = parse_order_commission_total(order)
    total_base_size = compute_order_total_base_size(
        order,
        numeric_base_size,
        numeric_filled_size,
        quote_size,
        side,
        numeric_price,
    )
    remaining_size = compute_order_remaining_base_size(order, total_base_size, numeric_filled_size)
    numeric_order_total = parse_order_gross_total(order, side, quote_size, commission_total)
    numeric_total_value = numeric_order_total

    filled_percent = (
        max(0, min(100, (numeric_filled_size / total_base_size) * 100))
        if total_base_size and numeric_filled_size is not None
        else None
    )
    order_type = order.get("order_type")
    bracket_legs = []
    take_profit_price = None
    stop_loss_price = None

    if isinstance(bracket_config, dict):
        order_type = "BRACKET"
        take_profit_price = parse_order_price(bracket_config.get("limit_price"))
        stop_loss_price = parse_order_price(bracket_config.get("stop_trigger_price"))
    elif not order_type and isinstance(order_configuration.get("limit_limit_gtc"), dict):
        order_type = "LIMIT"

    if str(order_type or "").upper() == "BRACKET" and bracket_config is None:
        take_profit_price = parse_order_price(
            config.get("take_profit_price")
            or config.get("limit_price")
            or order.get("take_profit_price")
            or order.get("limit_price")
        )
        stop_loss_price = parse_order_price(
            config.get("stop_loss_price")
            or config.get("stop_trigger_price")
            or config.get("stop_price")
            or order.get("stop_loss_price")
            or order.get("stop_trigger_price")
            or order.get("stop_price")
        )

    if str(order_type or "").upper() == "BRACKET":
        if take_profit_price is not None:
            bracket_legs.append({
                "id": f"{order_id}:take-profit",
                "cancel_id": order_id,
                "role": "take_profit",
                "side": side,
                "price": take_profit_price,
                "amount": remaining_size,
                "total_value": take_profit_price * remaining_size if remaining_size is not None else None,
                "base_size": total_base_size,
                "filled_size": numeric_filled_size,
                "filled_percent": filled_percent,
            })

        if stop_loss_price is not None:
            bracket_legs.append({
                "id": f"{order_id}:stop-loss",
                "cancel_id": order_id,
                "role": "stop_loss",
                "side": side,
                "price": stop_loss_price,
                "amount": remaining_size,
                "total_value": stop_loss_price * remaining_size if remaining_size is not None else None,
                "base_size": total_base_size,
                "filled_size": numeric_filled_size,
                "filled_percent": filled_percent,
            })

    return {
        "id": order_id,
        "product_id": order.get("product_id"),
        "side": side,
        "status": order.get("status"),
        "price": numeric_price,
        "amount": remaining_size,
        "total_value": numeric_total_value,
        "order_total": numeric_order_total,
        "commission_total": commission_total,
        "base_size": numeric_base_size,
        "total_base_size": total_base_size,
        "filled_size": numeric_filled_size,
        "filled_percent": filled_percent,
        "filled_value": positive_float(order.get("filled_value")),
        "average_filled_price": parse_order_price(order.get("average_filled_price")),
        "leaves_quantity": positive_float(order.get("leaves_quantity")),
        "quote_size": quote_size,
        "order_type": order_type,
        "client_order_id": str(order.get("client_order_id") or "").strip() or None,
        "bracket_legs": bracket_legs,
    }


def order_applies_to_product(order, product_id):
    normalized_product_id = product_id.upper()
    selected_base_currency = get_base_currency(normalized_product_id)
    order_product_id = str(order.get("product_id", "")).upper()

    return (
        order_product_id == normalized_product_id
        or get_base_currency(order_product_id) == selected_base_currency
    )


def get_base_currency(product_id):
    return str(product_id or "").upper().split("-", 1)[0]


def get_granularity_for_days(days, granularity=None):
    if granularity is not None:
        return granularity

    return 3600 if days <= 7 else 21600


def fetch_coinbase_candles(product_id, start, end, granularity):
    rows = []
    cursor = start
    chunk_seconds = granularity * CANDLE_REQUEST_LIMIT

    while cursor < end:
        chunk_end = min(end, cursor + timedelta(seconds=chunk_seconds))
        chunk_rows = coinbase_get(
            f"/products/{product_id}/candles",
            {
                "start": cursor.isoformat(),
                "end": chunk_end.isoformat(),
                "granularity": granularity,
            },
        )

        rows.extend(chunk_rows)
        cursor = chunk_end

    return rows


def normalize_candle_rows(rows):
    candles_by_time = {
        int(row[0]): {
            "time": int(row[0]),
            "low": float(row[1]),
            "high": float(row[2]),
            "open": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
        }
        for row in rows
    }

    candles = [
        {
            **candle,
        }
        for candle in candles_by_time.values()
    ]

    candles.sort(key=lambda candle: candle["time"])
    return candles


def build_candle_price_range(candles):
    if not candles:
        return None

    chart_min = min(candle["low"] for candle in candles)
    chart_max = max(candle["high"] for candle in candles)

    return {
        "min_price": chart_min * (1 - DEPTH_CHART_PADDING_RATIO),
        "max_price": chart_max * (1 + DEPTH_CHART_PADDING_RATIO),
    }


def aggregate_candles(candles, bucket_seconds, time_at_bucket_end=True):
    buckets = {}

    for candle in candles:
        bucket_time = int(candle["time"] // bucket_seconds * bucket_seconds)
        bucket = buckets.get(bucket_time)

        if bucket is None:
            buckets[bucket_time] = {
                "time": bucket_time,
                "open": candle["open"],
                "high": candle["high"],
                "low": candle["low"],
                "close": candle["close"],
                "volume": candle["volume"],
                "first_time": candle["time"],
                "last_time": candle["time"],
            }
            continue

        if candle["time"] < bucket["first_time"]:
            bucket["first_time"] = candle["time"]
            bucket["open"] = candle["open"]

        if candle["time"] > bucket["last_time"]:
            bucket["last_time"] = candle["time"]
            bucket["close"] = candle["close"]

        bucket["high"] = max(bucket["high"], candle["high"])
        bucket["low"] = min(bucket["low"], candle["low"])
        bucket["volume"] += candle["volume"]

    aggregated = [
        {
            "time": bucket["time"] + bucket_seconds if time_at_bucket_end else bucket["time"],
            "open": bucket["open"],
            "high": bucket["high"],
            "low": bucket["low"],
            "close": bucket["close"],
            "volume": bucket["volume"],
        }
        for bucket in buckets.values()
    ]
    aggregated.sort(key=lambda candle: candle["time"])
    return aggregated


def build_td_sequential_setups(candles):
    buy_count = 0
    sell_count = 0
    setups = []

    for index, candle in enumerate(candles):
        if index < 4:
            continue

        close = candle["close"]
        reference_close = candles[index - 4]["close"]

        if close > reference_close:
            sell_count = sell_count + 1 if sell_count > 0 else 1
            buy_count = 0

            if sell_count <= 9:
                setups.append({
                    "time": candle["time"],
                    "side": "sell",
                    "count": sell_count,
                    "complete": sell_count == 9,
                    "price": candle["close"],
                })
        elif close < reference_close:
            buy_count = buy_count + 1 if buy_count > 0 else 1
            sell_count = 0

            if buy_count <= 9:
                setups.append({
                    "time": candle["time"],
                    "side": "buy",
                    "count": buy_count,
                    "complete": buy_count == 9,
                    "price": candle["close"],
                })
        else:
            buy_count = 0
            sell_count = 0

    return setups


def is_open_order_status(status):
    normalized = str(status or "").upper()

    if not normalized:
        return True

    if normalized in {
        "OPEN",
        "PENDING",
        "QUEUED",
        "ACTIVE",
        "PARTIALLY_FILLED",
    }:
        return True

    if normalized in {
        "FILLED",
        "CANCELLED",
        "CANCELED",
        "EXPIRED",
        "FAILED",
        "REJECTED",
    }:
        return False

    if "PARTIALLY" in normalized:
        return True

    closed_markers = (
        "CANCEL",
        "FILLED",
        "EXPIRED",
        "FAILED",
        "REJECTED",
    )

    return not any(marker in normalized for marker in closed_markers)


def get_balance_refresh_mode_for_order_status(status):
    normalized = str(status or "").upper()

    if not normalized or normalized in PRE_CONFIRMATION_ORDER_STATUSES:
        return None

    if normalized == "PARTIALLY_FILLED" or "PARTIALLY" in normalized:
        return "debounced"

    return "immediate"


@app.get("/api/candles")
@coinbase_worker_endpoint
def get_candles(
    product_id: Annotated[str, Query()] = PRODUCT_ID,
    days: Annotated[int, Query(ge=1, le=28)] = 5,
    granularity: Annotated[Optional[int], Query()] = None,
    end_time: Annotated[Optional[int], Query()] = None,
    start_time: Annotated[Optional[int], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=CANDLE_REQUEST_LIMIT)] = CANDLE_REQUEST_LIMIT,
):
    candle_granularity = get_granularity_for_days(days, granularity)
    # Coinbase Exchange does not expose 4h (14400); fetch 1h and aggregate.
    four_hour_seconds = 4 * 60 * 60
    fetch_granularity = 3600 if candle_granularity == four_hour_seconds else candle_granularity

    if start_time is not None:
        start = datetime.fromtimestamp(start_time, timezone.utc)
        end = (
            datetime.fromtimestamp(end_time, timezone.utc)
            if end_time is not None
            else datetime.now(timezone.utc)
        )
        if start >= end:
            return {
                "candles": [],
                "price_range": None,
            }
    elif end_time is not None:
        end = datetime.fromtimestamp(end_time, timezone.utc)
        start = end - timedelta(seconds=candle_granularity * limit)
    else:
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days)

    rows = fetch_coinbase_candles(product_id, start, end, fetch_granularity)
    candles = normalize_candle_rows(rows)

    if candle_granularity == four_hour_seconds:
        candles = aggregate_candles(candles, four_hour_seconds, time_at_bucket_end=False)

    return {
        "candles": candles,
        "price_range": build_candle_price_range(candles),
    }


@app.get("/api/product")
@coinbase_worker_endpoint
def get_product(
    product_id: Annotated[str, Query()] = PRODUCT_ID,
):
    metadata = get_product_metadata(product_id.upper())

    return {
        "product_id": product_id.upper(),
        "quote_increment": metadata.get("quote_increment"),
        "base_increment": metadata.get("base_increment"),
        "quote_currency_id": metadata.get("quote_currency_id"),
        "base_currency_id": metadata.get("base_currency_id"),
    }


@app.get("/api/product-stats")
@coinbase_worker_endpoint
def get_product_stats(
    product_id: Annotated[str, Query()] = PRODUCT_ID,
):
    normalized_product_id = product_id.upper()
    stats = coinbase_get(f"/products/{normalized_product_id}/stats")
    open_price = parse_float(stats.get("open"))
    last_price = parse_float(stats.get("last"))
    change_24h = (
        ((last_price - open_price) / open_price) * 100
        if open_price and last_price is not None
        else None
    )

    return {
        "product_id": normalized_product_id,
        "price": last_price,
        "open_24h": open_price,
        "change_24h": change_24h,
    }


@app.get("/api/td-sequential")
@coinbase_worker_endpoint
def get_td_sequential(
    product_id: Annotated[str, Query()] = PRODUCT_ID,
    days: Annotated[int, Query(ge=7, le=56)] = 28,
):
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    rows = fetch_coinbase_candles(product_id, start, end, 3600)
    one_hour_candles = normalize_candle_rows(rows)
    now_time = int(end.timestamp())
    four_hour_candles = [
        candle
        for candle in aggregate_candles(one_hour_candles, 4 * 60 * 60)
        if candle["time"] <= now_time
    ]
    setups = build_td_sequential_setups(four_hour_candles)

    return {
        "product_id": product_id.upper(),
        "timeframe": "4h",
        "experimental": True,
        "candles": four_hour_candles,
        "setups": setups,
    }


def fetch_monitor_ticker(currency):
    product_id = f"{currency}-USD"

    try:
        stats = coinbase_get(f"/products/{product_id}/stats")
        open_price = parse_float(stats.get("open"))
        last_price = parse_float(stats.get("last"))
        change_24h = (
            ((last_price - open_price) / open_price) * 100
            if open_price and last_price is not None
            else None
        )

        if last_price is not None and last_price > 0:
            with usd_price_cache_lock:
                usd_price_cache[currency] = {
                    "price": last_price,
                    "time": time.monotonic(),
                }

        return {
            "currency": currency,
            "product_id": product_id,
            "price": last_price,
            "open_24h": open_price,
            "change_24h": change_24h,
            "error": None,
        }
    except HTTPException as exc:
        return {
            "currency": currency,
            "product_id": product_id,
            "price": None,
            "open_24h": None,
            "change_24h": None,
            "error": str(exc.detail),
        }


def build_monitor_tickers_payload():
	tickers = [fetch_monitor_ticker(currency) for currency in MONITOR_TICKERS]

	return {
		"quote_currency": "USD",
		"refresh_seconds": MONITOR_TICKERS_CACHE_SECONDS,
		"tickers": tickers,
	}


def get_cached_monitor_tickers_payload():
	now = time.monotonic()

	with monitor_tickers_cache_lock:
		payload = monitor_tickers_cache.get("payload")
		cached_at = float(monitor_tickers_cache.get("time") or 0)

		if (
			payload is not None
			and now - cached_at < MONITOR_TICKERS_CACHE_SECONDS
		):
			return payload

	with monitor_tickers_refresh_lock:
		now = time.monotonic()

		with monitor_tickers_cache_lock:
			payload = monitor_tickers_cache.get("payload")
			cached_at = float(monitor_tickers_cache.get("time") or 0)

			if (
				payload is not None
				and now - cached_at < MONITOR_TICKERS_CACHE_SECONDS
			):
				return payload

		payload = build_monitor_tickers_payload()

		with monitor_tickers_cache_lock:
			monitor_tickers_cache["payload"] = payload
			monitor_tickers_cache["time"] = time.monotonic()

		return payload


@app.get("/api/monitor-config")
def get_monitor_config():
	return {
		"tickers": MONITOR_TICKERS,
		"default_base_currency": MONITOR_TICKERS[0] if MONITOR_TICKERS else "BTC",
	}


@app.get("/api/monitor-tickers")
async def get_monitor_tickers():
	now = time.monotonic()

	with monitor_tickers_cache_lock:
		payload = monitor_tickers_cache.get("payload")
		cached_at = float(monitor_tickers_cache.get("time") or 0)

		if (
			payload is not None
			and now - cached_at < MONITOR_TICKERS_CACHE_SECONDS
		):
			return payload

	return await run_coinbase_call(get_cached_monitor_tickers_payload)


@app.get("/api/depth")
@coinbase_worker_endpoint
def get_depth(
    product_id: Annotated[str, Query()] = PRODUCT_ID,
    min_price: Annotated[Optional[float], Query()] = None,
    max_price: Annotated[Optional[float], Query()] = None,
):
    book = coinbase_get(f"/products/{product_id}/book", {"level": 2})

    def normalize(levels):
        normalized = []

        for price, size, order_count in levels:
            numeric_price = float(price)

            if min_price is not None and numeric_price < min_price:
                continue

            if max_price is not None and numeric_price > max_price:
                continue

            normalized.append({
                "price": numeric_price,
                "size": float(size),
                "orders": int(order_count),
            })

        return normalized

    bids = normalize(book.get("bids", []))
    asks = normalize(book.get("asks", []))

    current_price = None
    raw_bids = book.get("bids", [])
    raw_asks = book.get("asks", [])

    if raw_bids and raw_asks:
        current_price = (float(raw_bids[0][0]) + float(raw_asks[0][0])) / 2
    elif raw_bids:
        current_price = float(raw_bids[0][0])
    elif raw_asks:
        current_price = float(raw_asks[0][0])

    return {
        "product_id": product_id,
        "current_price": current_price,
        "min_price": min_price,
        "max_price": max_price,
        "bids": bids,
        "asks": asks,
    }


def parse_fill_timestamp(value):
    stamp = str(value or "").strip()

    if not stamp:
        return None

    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def normalize_fill_row(fill):
    if not isinstance(fill, dict):
        return None

    price = positive_float(fill.get("price"))
    # Coinbase returns BUY market-order size in quote currency when
    # size_in_quote=True; normalize every fill to base quantity + quote value.
    raw_size = parse_float(fill.get("size"))
    raw_size = abs(raw_size) if raw_size is not None else None
    raw_size = positive_float(raw_size) if raw_size is not None else None
    raw_size_in_quote = fill.get("size_in_quote")
    size_in_quote = (
        raw_size_in_quote is True
        or str(raw_size_in_quote or "").strip().lower() == "true"
    )
    size = (
        raw_size / price
        if raw_size is not None and price is not None and size_in_quote
        else raw_size
    )
    quote_size = (
        raw_size
        if raw_size is not None and size_in_quote
        else ((size * price) if size is not None and price is not None else None)
    )
    commission = positive_float(
        fill.get("commission")
        or fill.get("trade_fee")
        or fill.get("fee")
    ) or 0.0
    side = str(fill.get("side") or "").strip().upper()
    product_id = str(fill.get("product_id") or "").strip().upper()
    trade_time = (
        fill.get("trade_time")
        or fill.get("sequence_timestamp")
        or fill.get("created_at")
    )
    parsed_time = parse_fill_timestamp(trade_time)

    if (
        price is None
        or size is None
        or side not in {"BUY", "SELL"}
        or not product_id
        or parsed_time is None
    ):
        return None

    return {
        "product_id": product_id,
        "side": side,
        "price": price,
        "size": size,
        "quote_size": quote_size,
        "size_in_quote": size_in_quote,
        "commission": commission,
        "time": parsed_time,
        "time_iso": parsed_time.isoformat().replace("+00:00", "Z"),
    }


def fetch_fills_for_products(product_ids, start_time_iso=None):
    fills = []
    cursor = None
    normalized_products = [
        str(product_id).strip().upper()
        for product_id in (product_ids or [])
        if str(product_id or "").strip()
    ]

    if not normalized_products:
        return []

    for _ in range(AVG_ENTRY_FILL_MAX_PAGES):
        params = {
            "product_ids": normalized_products,
            "limit": AVG_ENTRY_FILL_PAGE_LIMIT,
        }

        if start_time_iso:
            params["start_sequence_timestamp"] = start_time_iso

        if cursor:
            params["cursor"] = cursor

        data = coinbase_advanced_get(
            "/api/v3/brokerage/orders/historical/fills",
            params,
        )
        batch = data.get("fills") if isinstance(data, dict) else None

        if not isinstance(batch, list) or not batch:
            break

        fills.extend(batch)
        cursor = data.get("cursor")

        if not cursor:
            break

    return fills


def compute_avg_from_newest_buys(normalized_fills, balance_qty):
    """
    When fill inventory ≠ wallet (transfers, truncated history, false flats),
    cost the live bag from newest BUY fills only (no sell expansion).
    Trade price only — no fees (matches Coinbase avg entry).
    """
    target_qty = positive_float(balance_qty)
    if target_qty is None or target_qty <= 0:
        return None

    need = target_qty
    cost = 0.0
    taken = 0.0

    for fill in reversed(normalized_fills or []):
        if need <= 1e-12:
            break
        if fill.get("side") != "BUY":
            continue
        size = float(fill["size"])
        price = float(fill["price"])
        take = min(size, need)
        if take <= 0:
            continue
        cost += take * price
        taken += take
        need -= take

    if taken <= 0 or need / target_qty > 0.05:
        return None

    return cost / taken


def _avg_prices_near(left, right, rel_tol=0.01):
    a = positive_float(left)
    b = positive_float(right)
    if a is None or b is None or a <= 0 or b <= 0:
        return False
    return abs(a - b) / max(a, b) <= rel_tol


def _newest_buy_price_from_fills(fills):
    newest = None
    newest_time = None

    for fill in fills or []:
        row = normalize_fill_row(fill)
        if row is None or row.get("side") != "BUY":
            continue
        stamp = row.get("time")
        if newest is None or (stamp is not None and (newest_time is None or stamp > newest_time)):
            newest = float(row["price"])
            newest_time = stamp

    return newest


def _is_newest_buys_avg_flash(stored_avg, computed_avg, fills):
    """
    After an add-on buy, newest_buys can briefly equal the latest fill price and
    yank the chart off a known-good bag average. Detect that flash.
    """
    if stored_avg is None or computed_avg is None:
        return False
    if _avg_prices_near(computed_avg, stored_avg):
        return False

    newest_buy = _newest_buy_price_from_fills(fills)
    if newest_buy is None:
        return False

    return _avg_prices_near(computed_avg, newest_buy)


def compute_avg_entry_from_fills(fills, balance_qty=None):
    """
    Coinbase-style average entry for the open bag:
    buys update weighted avg at trade price (no fees); sells reduce qty only;
    going flat resets the window.

    When balance_qty is provided:
    - match within ~5% → forward avg
    - fill qty < live bag (deposits/gaps) → keep forward avg (PENGU)
    - fill qty > live bag (truncated/missing sells) → newest BUY cover (ICP)
    """
    normalized = []

    for fill in fills or []:
        row = normalize_fill_row(fill)
        if row is not None:
            normalized.append(row)

    normalized.sort(key=lambda row: row["time"])

    qty = 0.0
    avg = 0.0
    null_date_iso = None

    for fill in normalized:
        size = float(fill["size"])
        price = float(fill["price"])

        if fill["side"] == "BUY":
            next_qty = qty + size
            if next_qty > 1e-12:
                avg = ((qty * avg) + (size * price)) / next_qty
            qty = next_qty
        else:
            # Never let sells drive qty negative (missing buys / transfers).
            sell = min(size, qty) if qty > 0 else 0.0
            qty -= sell
            if (
                qty <= 1e-12
                or qty * price < AVG_ENTRY_DUST_USD
            ):
                qty = 0.0
                avg = 0.0
                null_date_iso = fill["time_iso"]

    target_qty = positive_float(balance_qty)
    forward_avg = avg if qty > 1e-12 and avg > 0 else None

    if target_qty is None:
        return {
            "avg_price": forward_avg,
            "qty": qty,
            "null_date": null_date_iso,
            "fill_count": len(normalized),
        }

    if forward_avg is not None and qty > 0:
        rel_diff = abs(qty - target_qty) / max(target_qty, qty)
        if rel_diff <= 0.05:
            return {
                "avg_price": forward_avg,
                "qty": target_qty,
                "null_date": null_date_iso,
                "fill_count": len(normalized),
                "source": "forward",
            }

        # Wallet larger than fill inventory: transfers/gaps — keep post-flat avg.
        if qty + 1e-12 < target_qty:
            return {
                "avg_price": forward_avg,
                "qty": target_qty,
                "null_date": null_date_iso,
                "fill_count": len(normalized),
                "source": "forward_underfill",
            }

    newest_avg = compute_avg_from_newest_buys(normalized, target_qty)
    if newest_avg is not None:
        return {
            "avg_price": newest_avg,
            "qty": target_qty,
            "null_date": null_date_iso,
            "fill_count": len(normalized),
            "source": "newest_buys",
        }

    if forward_avg is not None:
        return {
            "avg_price": forward_avg,
            "qty": target_qty,
            "null_date": null_date_iso,
            "fill_count": len(normalized),
            "source": "forward_fallback",
        }

    return {
        "avg_price": None,
        "qty": target_qty,
        "null_date": null_date_iso,
        "fill_count": len(normalized),
        "reason": "qty_mismatch",
    }


def build_avg_entry_for_currency(currency, force=False):
    normalized_currency = normalize_bookmark_currency(currency)
    force_refresh = bool(force)

    if normalized_currency in USD_PEGGED_CURRENCIES:
        return {
            "currency": normalized_currency,
            "avg_price": None,
            "qty": 0.0,
            "null_date": None,
            "usd_value": 0.0,
            "tracked": False,
            "reason": "quote_currency",
            "source": "none",
            "state_updated": False,
        }

    # Prefer priced balances so missing ticker cache cannot fake dust.
    balances = get_cached_balances(force_prices=force_refresh).get("balances") or []
    balance = next(
        (
            row
            for row in balances
            if str(row.get("currency") or "").upper() == normalized_currency
        ),
        None,
    )
    balance_qty = positive_float((balance or {}).get("total")) or 0.0
    usd_price = positive_float((balance or {}).get("usd_price"))
    usd_value = positive_float((balance or {}).get("usd_value"))

    if usd_value is None and usd_price is not None:
        usd_value = balance_qty * usd_price

    value_known = usd_value is not None
    usd_value = usd_value if value_known else None
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    stored = get_avg_entry_record(normalized_currency) or {}
    stored_null_date = str(stored.get("nullDate") or "").strip() or None
    stored_avg = positive_float(stored.get("avgPrice"))
    stored_qty = parse_float(stored.get("qty"))
    stored_qty = stored_qty if stored_qty is not None and stored_qty >= 0 else 0.0

    # Flat / under $1: stamp nullDate once when bag becomes empty of avg.
    # Do NOT rewrite nullDate=now on every poll — that looped app_state writes.
    is_dust = balance_qty <= 0 or (value_known and usd_value < AVG_ENTRY_DUST_USD)

    if is_dust:
        already_flat = stored_avg is None and stored_qty <= 0 and bool(stored_null_date)
        if already_flat:
            return {
                "currency": normalized_currency,
                "avg_price": None,
                "qty": balance_qty,
                "null_date": stored_null_date,
                "usd_value": usd_value if value_known else 0.0,
                "tracked": False,
                "reason": "dust",
                "source": "dust",
                "state_updated": False,
            }

        set_avg_entry_record(
            normalized_currency,
            null_date=now_iso,
            avg_price=None,
            qty=0.0,
        )
        return {
            "currency": normalized_currency,
            "avg_price": None,
            "qty": balance_qty,
            "null_date": now_iso,
            "usd_value": usd_value if value_known else 0.0,
            "tracked": False,
            "reason": "dust",
            "source": "dust",
            "state_updated": True,
        }

    if not force_refresh and stored_avg is not None:
        return {
            "currency": normalized_currency,
            "avg_price": stored_avg,
            "qty": stored_qty if stored_qty > 0 else balance_qty,
            "null_date": stored_null_date,
            "usd_value": usd_value if value_known else None,
            "tracked": True,
            "reason": None,
            "source": "cache",
            "state_updated": False,
        }

    # Unpriced but non-zero qty: keep cache; don't invent dust.
    if not value_known and not force_refresh and stored_avg is not None:
        return {
            "currency": normalized_currency,
            "avg_price": stored_avg,
            "qty": stored_qty if stored_qty > 0 else balance_qty,
            "null_date": stored_null_date,
            "usd_value": None,
            "tracked": True,
            "reason": None,
            "source": "cache",
            "state_updated": False,
        }

    product_ids = [
        f"{normalized_currency}-USD",
        f"{normalized_currency}-USDC",
    ]

    def fetch_and_compute(start_time_iso):
        fills = fetch_fills_for_products(product_ids, start_time_iso=start_time_iso)
        return compute_avg_entry_from_fills(fills, balance_qty=balance_qty), fills

    try:
        # The remembered <$1 timestamp is the cost-basis boundary. Force refresh
        # refreshes fills inside that window; it must not discard the boundary.
        computed, fills = fetch_and_compute(stored_null_date)
        matched_qty = float(computed.get("qty") or 0.0)

        # Cold/missing state gets one historical backtrack to discover a basis.
        # Never replace an existing tracked basis with unrelated full history.
        if (
            stored_avg is None
            and stored_null_date is not None
            and (
                computed.get("avg_price") is None
                or matched_qty + 1e-8 < balance_qty
            )
        ):
            computed, fills = fetch_and_compute(None)
    except HTTPException as exc:
        return {
            "currency": normalized_currency,
            "avg_price": stored_avg,
            "qty": stored_qty if stored_qty > 0 else balance_qty,
            "null_date": stored_null_date,
            "usd_value": usd_value if value_known else None,
            "tracked": stored_avg is not None,
            "reason": "fills_failed",
            "error": exc.detail,
            "source": "cache" if stored_avg is not None else "none",
            "state_updated": False,
        }

    next_null_date = computed.get("null_date") or stored_null_date
    avg_price = computed.get("avg_price")
    next_qty = balance_qty
    mismatch = computed.get("reason") == "qty_mismatch"

    # Never wipe a known-good avg when recompute fails / qty mismatches.
    # Only replace cache when we computed a real average.
    if avg_price is None and stored_avg is not None:
        return {
            "currency": normalized_currency,
            "avg_price": stored_avg,
            "qty": stored_qty if stored_qty > 0 else balance_qty,
            "null_date": stored_null_date,
            "usd_value": usd_value if value_known else None,
            "tracked": True,
            "fill_count": computed.get("fill_count") or 0,
            "reason": "qty_mismatch_keep_cache" if mismatch else "no_fills_keep_cache",
            "source": "cache",
            "state_updated": False,
        }

    # Don't flash the chart to the latest buy when newest_buys briefly wins.
    if (
        stored_avg is not None
        and avg_price is not None
        and computed.get("source") == "newest_buys"
        and _is_newest_buys_avg_flash(stored_avg, avg_price, fills)
    ):
        return {
            "currency": normalized_currency,
            "avg_price": stored_avg,
            "qty": stored_qty if stored_qty > 0 else balance_qty,
            "null_date": stored_null_date,
            "usd_value": usd_value if value_known else None,
            "tracked": True,
            "fill_count": computed.get("fill_count") or 0,
            "reason": "newest_buys_flash_keep_cache",
            "source": "cache",
            "method": "newest_buys",
            "state_updated": False,
        }

    state_updated = (
        avg_price != stored_avg
        or next_null_date != stored_null_date
        or abs(next_qty - stored_qty) > 1e-12
    )

    # Do not persist null avgPrice for a live bag — that blanks the chart line.
    # Only the dust path above is allowed to clear avg.
    if state_updated and avg_price is not None:
        set_avg_entry_record(
            normalized_currency,
            null_date=next_null_date,
            avg_price=avg_price,
            qty=next_qty,
        )

    return {
        "currency": normalized_currency,
        "avg_price": avg_price,
        "qty": next_qty,
        "null_date": next_null_date if avg_price is not None else stored_null_date,
        "usd_value": usd_value if value_known else None,
        "tracked": avg_price is not None,
        "fill_count": computed.get("fill_count") or 0,
        "reason": (
            None if avg_price is not None
            else ("qty_mismatch" if mismatch else "no_fills")
        ),
        "source": "recompute",
        "method": computed.get("source"),
        "state_updated": bool(state_updated and avg_price is not None),
    }


@app.get("/api/avg-entry/{currency}")
async def get_avg_entry(
    currency: str,
    force: Annotated[bool, Query()] = False,
):
    normalized_currency = normalize_bookmark_currency(currency)
    result = await run_coinbase_singleflight(
        ("avg-entry", normalized_currency, bool(force)),
        build_avg_entry_for_currency,
        normalized_currency,
        force,
        _lane="avg-entry",
    )

    if result.get("state_updated"):
        async with app_state_lock:
            state = app_state_payload()

        await broadcast_app_state(state, {
            "type": "avg_entry_updated",
            "currency": result.get("currency"),
            "avg_price": result.get("avg_price"),
            "qty": result.get("qty"),
            "null_date": result.get("null_date"),
        })

    return result


@app.get("/api/orders")
@coinbase_worker_endpoint(lane="orders")
def get_orders(
    product_id: Annotated[str, Query()] = PRODUCT_ID,
    all_products: Annotated[bool, Query()] = False,
    force: Annotated[bool, Query()] = False,
):
    normalized_product_id = product_id.upper()
    selected_base_currency = get_base_currency(normalized_product_id)
    trailing_orders = [
        order
        for order in get_trailing_orders()
        if all_products or order_applies_to_product(order, normalized_product_id)
    ]

    try:
        raw_orders = get_cached_open_orders_raw(force=True)
    except HTTPException as exc:
        print(
            f"COINBASE CONNECT FAILED product={normalized_product_id} status={exc.status_code} detail={exc.detail}",
            flush=True,
        )
        return {
            "product_id": normalized_product_id,
            "open_total": len(trailing_orders),
            "exact_total": len(trailing_orders),
            "applicable_total": len(trailing_orders),
            "drawable_total": len(trailing_orders) + len(
                orders_list_drawable(normalized_product_id, all_products, trailing_orders)
            ),
            "skipped_total": 0,
            "orders": [
                *[trailing_public_view(order) for order in trailing_orders],
                *orders_list_drawable(normalized_product_id, all_products, trailing_orders),
            ],
            "error": exc.detail,
        }

    trailing_backing_order_ids = {
        str(order.get("coinbase_order_id"))
        for order in trailing_orders
        if order.get("coinbase_order_id")
    }
    raw_orders = [
        order
        for order in raw_orders
        if str(order.get("order_id") or order.get("id") or "") not in trailing_backing_order_ids
    ]

    if all_products:
        exact_product_orders = []
        product_orders = raw_orders
    else:
        exact_product_orders = [
            order
            for order in raw_orders
            if str(order.get("product_id", "")).upper() == normalized_product_id
        ]
        product_orders = [
            order
            for order in raw_orders
            if order_applies_to_product(order, normalized_product_id)
        ]
    orders = [trailing_public_view(order) for order in trailing_orders]
    skipped = 0

    orders_list_sync_from_coinbase(raw_orders)
    drawable_orders = orders_list_drawable(normalized_product_id, all_products, trailing_orders)
    orders.extend(drawable_orders)

    print(
        "COINBASE CONNECT OK "
        f"product={normalized_product_id} "
        f"base={selected_base_currency} "
        f"all_products={all_products} "
        f"force={bool(force)} "
        f"open_total={len(raw_orders)} "
        f"exact={len(exact_product_orders)} "
        f"applicable={len(product_orders)} "
        f"drawable={len(orders)} "
        f"skipped={skipped}",
        flush=True,
    )

    return {
        "product_id": normalized_product_id,
        "open_total": len(raw_orders) + len(trailing_orders),
        "exact_total": len(exact_product_orders) + len(trailing_orders),
        "applicable_total": len(product_orders) + len(trailing_orders),
        "drawable_total": len(orders),
        "skipped_total": skipped,
        "orders": orders,
    }


def _orders_find_locked(original_id=None, coinbase_id=None, client_order_id=None):
    if original_id:
        target = str(original_id)
        for entry in _orders_list:
            if str(entry.get("original_id") or "") == target:
                return entry

    if client_order_id:
        target = str(client_order_id)
        for entry in _orders_list:
            if str(entry.get("client_order_id") or "") == target:
                return entry

    if coinbase_id:
        target = str(coinbase_id)
        for entry in _orders_list:
            if str(entry.get("coinbase_id") or "") == target or str(entry.get("id") or "") == target:
                return entry

    return None


def _dedupe_orders_list_locked():
    unique = {}
    leftovers = []

    for entry in _orders_list:
        original_id = str(entry.get("original_id") or "")
        if not original_id:
            leftovers.append(entry)
            continue

        existing = unique.get(original_id)
        if existing is None:
            unique[original_id] = entry
            continue

        existing_status = str(existing.get("status") or "OPEN").upper()
        next_status = str(entry.get("status") or "OPEN").upper()
        keep_existing = existing_status in ("PENDING", "ERROR") and next_status not in ("PENDING", "ERROR")
        unique[original_id] = existing if keep_existing else entry

    _orders_list[:] = list(unique.values()) + leftovers


def orders_list_find(original_id=None, coinbase_id=None):
    with _orders_list_lock:
        entry = _orders_find_locked(original_id=original_id, coinbase_id=coinbase_id)
        return dict(entry) if entry else None


def _new_original_id():
    return f"order-{secrets.token_hex(16)}"


def resolve_buy_original_value_usd(raw_order=None, normalized=None, place_payload=None):
    if isinstance(place_payload, dict):
        value = positive_float(place_payload.get("quote_size"))
        if value and value > 0:
            return value

    if isinstance(normalized, dict):
        value = positive_float(normalized.get("quote_size"))
        if value and value > 0:
            return value

    if isinstance(raw_order, dict):
        configuration = raw_order.get("order_configuration") or {}
        config = configuration.get("limit_limit_gtc") if isinstance(configuration.get("limit_limit_gtc"), dict) else {}
        value = positive_float(config.get("quote_size"))
        if value and value > 0:
            return value

    return None


BUY_PARENT_DOLLAR_KEYS = frozenset({
    "original_value_usd",
    "used_value_usd",
    "remaining_value_usd",
    "used_percent",
    "used_before_current_order_usd",
    "child_filled_value_usd",
})


def _is_buy_limit_entry(entry):
    if not isinstance(entry, dict):
        return False
    if str(entry.get("side") or "").lower() != "buy":
        return False
    order_type = str(entry.get("order_type") or "").upper()
    return order_type == "LIMIT" or order_type == ""


def _set_buy_original_once(entry, original_value_usd):
    """ORIGINAL is immutable. Set only when missing."""
    existing = positive_float(entry.get("original_value_usd"))
    if existing and existing > 0:
        return existing

    original = positive_float(original_value_usd)
    if not original or original <= 0:
        return None

    entry["original_value_usd"] = float(original)
    entry["used_value_usd"] = 0.0
    entry["remaining_value_usd"] = float(original)
    entry["used_before_current_order_usd"] = 0.0
    entry.pop("used_percent", None)
    return float(original)


def _apply_buy_used(entry, used_value_usd):
    """Update USED + REMAINING only. Never touches ORIGINAL."""
    original = positive_float(entry.get("original_value_usd"))
    if not original or original <= 0:
        return entry

    used = min(original, max(0.0, float(used_value_usd)))
    entry["used_value_usd"] = used
    entry["remaining_value_usd"] = max(0.0, original - used)
    entry.pop("used_percent", None)
    return entry


def _buy_leg_fill_notional(raw_order=None, entry=None, price_override=None):
    """Dollar filled on the current Coinbase child only — never revalue at a moved limit price."""
    if isinstance(raw_order, dict):
        filled_value = positive_float(raw_order.get("filled_value"))
        if filled_value and filled_value > 0:
            return filled_value

        filled = positive_float(
            raw_order.get("filled_size") or raw_order.get("cumulative_quantity")
        ) or 0.0
        if filled <= 0:
            return 0.0

        avg = parse_order_price(raw_order.get("average_filled_price"))
        if avg and avg > 0:
            return filled * avg

        configuration = raw_order.get("order_configuration") or {}
        config = (
            configuration.get("limit_limit_gtc")
            if isinstance(configuration.get("limit_limit_gtc"), dict)
            else {}
        )
        limit_price = parse_order_price(price_override) or parse_order_price(config.get("limit_price"))
        if limit_price and limit_price > 0:
            return filled * limit_price
        return 0.0

    if isinstance(entry, dict):
        stamped = positive_float(entry.get("child_filled_value_usd"))
        if stamped and stamped > 0:
            return stamped

        filled = positive_float(entry.get("filled_size")) or 0.0
        if filled <= 0:
            return 0.0

        avg = parse_order_price(entry.get("average_filled_price"))
        if avg and avg > 0:
            return filled * avg

        # Prefer the price this child was filled against — not a later moved limit.
        fill_price = (
            parse_order_price(price_override)
            or parse_order_price(entry.get("previous_price"))
            or parse_order_price(entry.get("price"))
        )
        if fill_price and fill_price > 0:
            return filled * fill_price

    return 0.0


def _sync_buy_used_from_fill(entry, raw_order):
    """
    Utilization event only: grow USED from this Coinbase child's fill $.
    ORIGINAL is never changed. No-op without a Coinbase raw fill snapshot.
    """
    if not isinstance(raw_order, dict) or not _is_buy_limit_entry(entry):
        return entry

    original_value_usd = positive_float(entry.get("original_value_usd"))
    if not original_value_usd or original_value_usd <= 0:
        return entry

    # Replace in flight: parent USED is frozen until the new child is attached.
    if str(entry.get("status") or "OPEN").upper() == "PENDING":
        return entry

    current_used = positive_float(entry.get("used_value_usd")) or 0.0
    used_before = positive_float(entry.get("used_before_current_order_usd")) or 0.0
    leg_used = _buy_leg_fill_notional(raw_order=raw_order) or 0.0

    if leg_used > 0:
        entry["child_filled_value_usd"] = leg_used
        avg = parse_order_price(raw_order.get("average_filled_price"))
        if avg and avg > 0:
            entry["average_filled_price"] = avg
    elif positive_float(raw_order.get("filled_size") or raw_order.get("cumulative_quantity")) in (None, 0):
        entry["child_filled_value_usd"] = 0.0

    # used_before = parent USED when this Coinbase child started empty.
    # USED only grows from real child fills — never shrink.
    return _apply_buy_used(entry, max(current_used, used_before + leg_used))


def _finalize_order_entry(entry):
    if not entry.get("original_id"):
        entry["original_id"] = _new_original_id()
    entry["visualKey"] = entry["original_id"]
    if not entry.get("coinbase_id") and entry.get("id") and not str(entry.get("id")).startswith("order-"):
        entry["coinbase_id"] = str(entry.get("id"))
    # Do not recompute BUY parent dollars here — ORIGINAL/USED only change at
    # create (original once) or fill events (_sync_buy_used_from_fill).
    return dict(entry)


def order_public_view(entry):
    public = _finalize_order_entry(dict(entry))
    local_id = str(public.get("original_id") or "")
    if local_id:
        public["original_id"] = local_id
    public.pop("id", None)
    public.pop("visualKey", None)
    public.pop("cancel_id", None)
    public.pop("coinbase_id", None)
    public.pop("coinbase_order_id", None)
    public.pop("client_order_id", None)
    public.pop("previous_price", None)
    public.pop("previous_stop_price", None)
    # Backend-only replace bookkeeping / derived % — not display source of truth.
    public.pop("used_before_current_order_usd", None)
    public.pop("child_filled_value_usd", None)
    public.pop("used_percent", None)
    legs = []
    for leg in public.get("bracket_legs") or []:
        if not isinstance(leg, dict):
            continue
        public_leg = dict(leg)
        public_leg.pop("id", None)
        public_leg.pop("visualKey", None)
        public_leg.pop("cancel_id", None)
        public_leg.pop("coinbase_id", None)
        public_leg.pop("coinbase_order_id", None)
        public_leg.pop("client_order_id", None)
        legs.append(public_leg)
    public["bracket_legs"] = legs
    # List $ and chart TP $ must be the same TP leg total.
    if str(public.get("order_type") or "").upper() == "BRACKET":
        for leg in legs:
            if str(leg.get("role") or "").lower() != "take_profit":
                continue
            tp_total = positive_float(leg.get("total_value") or leg.get("order_total"))
            if tp_total and tp_total > 0:
                public["total_value"] = tp_total
                public["order_total"] = tp_total
            break
    return public


def trailing_public_view(order):
    if not isinstance(order, dict):
        return order
    public = dict(order)
    local_id = str(public.get("original_id") or public.get("id") or "")
    public["original_id"] = local_id
    public.pop("id", None)
    public.pop("coinbase_order_id", None)
    public.pop("trigger_client_order_id", None)
    return public


def resolve_tracked_entry(order_id):
    target = str(order_id or "").strip()
    if not target:
        return None
    return (
        orders_list_find(original_id=target)
        or orders_list_find(coinbase_id=target)
    )


def tracked_coinbase_id(entry):
    if not isinstance(entry, dict):
        return None
    return str(entry.get("coinbase_id") or entry.get("id") or "") or None


def _local_status_from_coinbase(status):
    """Coinbase PENDING/QUEUED is not our BUY-replace PENDING — treat as OPEN."""
    normalized = str(status or "OPEN").upper()
    if normalized in ("PENDING", "QUEUED", ""):
        return "OPEN"
    return normalized


def build_bracket_legs(
    order_id,
    side,
    take_profit_price,
    stop_loss_price,
    amount=None,
    total_base_size=None,
    filled_size=None,
    filled_percent=None,
):
    legs = []
    if take_profit_price is not None:
        legs.append({
            "id": f"{order_id}:take-profit",
            "cancel_id": order_id,
            "role": "take_profit",
            "side": side,
            "price": take_profit_price,
            "amount": amount,
            "total_value": take_profit_price * amount if amount is not None else None,
            "base_size": total_base_size,
            "filled_size": filled_size,
            "filled_percent": filled_percent,
        })
    if stop_loss_price is not None:
        legs.append({
            "id": f"{order_id}:stop-loss",
            "cancel_id": order_id,
            "role": "stop_loss",
            "side": side,
            "price": stop_loss_price,
            "amount": amount,
            "total_value": stop_loss_price * amount if amount is not None else None,
            "base_size": total_base_size,
            "filled_size": filled_size,
            "filled_percent": filled_percent,
        })
    return legs


def apply_place_payload_fields(normalized, place_payload):
    """Fill the same order fields limits use (price + bracket_legs) from place body."""
    if not isinstance(normalized, dict):
        return normalized

    payload = place_payload if isinstance(place_payload, dict) else {}
    order_type = str(
        normalized.get("order_type") or payload.get("order_type") or ""
    ).upper()
    order_id = normalized.get("id")
    side = str(normalized.get("side") or payload.get("side") or "").lower()
    amount = positive_float(normalized.get("amount"))
    total_base_size = positive_float(normalized.get("total_base_size") or normalized.get("base_size"))
    filled_size = positive_float(normalized.get("filled_size"))
    filled_percent = normalized.get("filled_percent")

    take_profit_price = parse_order_price(
        payload.get("take_profit_price")
        or payload.get("limit_price")
    )
    stop_loss_price = parse_order_price(
        payload.get("stop_loss_price")
        or payload.get("stop_trigger_price")
        or payload.get("stop_price")
    )
    limit_price = parse_order_price(
        payload.get("limit_price")
        or payload.get("stop_price")
        or payload.get("take_profit_price")
    )

    if (
        order_type == "BRACKET"
        or str(payload.get("order_type") or "").upper() == "BRACKET"
    ):
        normalized["order_type"] = "BRACKET"
        if parse_order_price(normalized.get("price")) is None and take_profit_price is not None:
            normalized["price"] = take_profit_price
        if not normalized.get("bracket_legs"):
            normalized["bracket_legs"] = build_bracket_legs(
                order_id,
                side,
                take_profit_price,
                stop_loss_price,
                amount=amount,
                total_base_size=total_base_size,
                filled_size=filled_size,
                filled_percent=filled_percent,
            )
        # Parent list $ = TP leg $ (same field chart TP uses).
        for leg in normalized.get("bracket_legs") or []:
            if str(leg.get("role") or "").lower() != "take_profit":
                continue
            tp_total = positive_float(leg.get("total_value") or leg.get("order_total"))
            if tp_total and tp_total > 0:
                normalized["total_value"] = tp_total
                normalized["order_total"] = tp_total
            break
    elif (
        order_type == "TRAILING_LIMIT"
        or str(payload.get("order_type") or "").upper() == "TRAILING_LIMIT"
    ):
        normalized["order_type"] = "TRAILING_LIMIT"
        trail_percent = positive_float(payload.get("trail_percent") or normalized.get("trail_percent"))
        highest_price = positive_float(payload.get("highest_price") or normalized.get("highest_price"))
        stop_price = parse_order_price(
            payload.get("stop_price")
            or payload.get("limit_price")
            or normalized.get("stop_price")
            or normalized.get("price")
        )
        if trail_percent is not None:
            normalized["trail_percent"] = trail_percent
        if highest_price is not None:
            normalized["highest_price"] = highest_price
        if stop_price is not None:
            normalized["stop_price"] = stop_price
            normalized["price"] = stop_price
    elif parse_order_price(normalized.get("price")) is None and limit_price is not None:
        normalized["price"] = limit_price

    return normalized


def build_normalized_from_place_payload(order_id, product_id, side, order_type, place_payload):
    """Same normalized shape as Coinbase historical — built from place body fields."""
    payload = place_payload if isinstance(place_payload, dict) else {}
    order_type = str(order_type or payload.get("order_type") or "").upper()
    side = str(side or payload.get("side") or "").lower()
    base_size = positive_float(payload.get("preview_base_size") or payload.get("base_size"))

    seed = {
        "id": order_id,
        "product_id": product_id,
        "side": side,
        "order_type": order_type or "LIMIT",
        "price": None,
        "amount": base_size,
        "base_size": base_size,
        "total_base_size": base_size,
        "filled_percent": 0,
        "bracket_legs": [],
        "status": "OPEN",
    }
    seed = apply_place_payload_fields(seed, payload)
    return apply_preview_snapshot_to_order(seed, payload)


def _preserve_local_bracket_fields(entry, incoming=None):
    """Don't let a half-baked Coinbase snapshot wipe TP/SL legs."""
    if not isinstance(entry, dict):
        return entry

    incoming_legs = None
    if isinstance(incoming, dict):
        incoming_legs = incoming.get("bracket_legs")

    local_legs = entry.get("bracket_legs")
    if (
        (not isinstance(incoming_legs, list) or not incoming_legs)
        and isinstance(local_legs, list)
        and local_legs
    ):
        entry["bracket_legs"] = local_legs
        if str(entry.get("order_type") or "").upper() != "BRACKET":
            entry["order_type"] = "BRACKET"
    elif (
        isinstance(incoming, dict)
        and str(incoming.get("order_type") or "").upper() == "BRACKET"
        and (not isinstance(entry.get("bracket_legs"), list) or not entry.get("bracket_legs"))
        and isinstance(local_legs, list)
        and local_legs
    ):
        entry["bracket_legs"] = local_legs

    return entry


def orders_list_upsert_from_coinbase(normalized, raw_order=None, place_payload=None):
    if not isinstance(normalized, dict) or not normalized.get("id"):
        return None

    if place_payload is not None:
        normalized = apply_place_payload_fields(dict(normalized), place_payload)

    coinbase_id = str(normalized["id"])
    coinbase_open_status = _local_status_from_coinbase(normalized.get("status"))

    with _orders_list_lock:
        client_order_id = str(normalized.get("client_order_id") or "").strip()
        entry = _orders_find_locked(
            original_id=normalized.get("original_id"),
            coinbase_id=coinbase_id,
            client_order_id=client_order_id,
        )

        # Generic Coinbase updates cannot mutate backend-owned terminal/in-flight rows.
        # The exact operation transitions PENDING to OPEN or ERROR.
        if (
            entry is not None
            and place_payload is None
            and str(entry.get("status") or "").upper() in ("PENDING", "ERROR")
        ):
            return _finalize_order_entry(dict(entry))

        if entry is None:
            entry = dict(normalized)
            entry["original_id"] = _new_original_id()
            entry["status"] = coinbase_open_status
            if _is_buy_limit_entry(entry):
                _set_buy_original_once(
                    entry,
                    resolve_buy_original_value_usd(
                        raw_order=raw_order,
                        normalized=normalized,
                        place_payload=place_payload,
                    ),
                )
            _orders_list.append(entry)
        else:
            preserved_status = str(entry.get("status") or "OPEN").upper()
            preserved = {
                "original_id": entry.get("original_id"),
                "visualKey": entry.get("visualKey"),
                "original_value_usd": entry.get("original_value_usd"),
                "used_before_current_order_usd": entry.get("used_before_current_order_usd"),
                "used_value_usd": entry.get("used_value_usd"),
                "remaining_value_usd": entry.get("remaining_value_usd"),
                "child_filled_value_usd": entry.get("child_filled_value_usd"),
                "previous_price": entry.get("previous_price"),
                "previous_stop_price": entry.get("previous_stop_price"),
            }
            if preserved_status == "ERROR":
                preserved["status"] = "ERROR"
            prior_legs = entry.get("bracket_legs")
            prior_order_type = entry.get("order_type")
            prior_trail_percent = entry.get("trail_percent")
            prior_highest_price = entry.get("highest_price")
            prior_stop_price = entry.get("stop_price")
            entry.update(normalized)
            entry.update({key: value for key, value in preserved.items() if value is not None})
            if isinstance(prior_legs, list) and prior_legs:
                incoming_legs = normalized.get("bracket_legs")
                if not isinstance(incoming_legs, list) or not incoming_legs:
                    entry["bracket_legs"] = prior_legs
                    if str(prior_order_type or "").upper() == "BRACKET":
                        entry["order_type"] = "BRACKET"
            if str(prior_order_type or "").upper() == "TRAILING_LIMIT":
                entry["order_type"] = "TRAILING_LIMIT"
                if prior_trail_percent is not None:
                    entry["trail_percent"] = prior_trail_percent
                if prior_highest_price is not None:
                    entry["highest_price"] = prior_highest_price
                if prior_stop_price is not None:
                    entry["stop_price"] = prior_stop_price
            _preserve_local_bracket_fields(entry, normalized)
            if preserved_status != "ERROR":
                entry["status"] = coinbase_open_status

        entry["coinbase_id"] = coinbase_id
        entry["id"] = coinbase_id

        if place_payload is not None:
            apply_place_payload_fields(entry, place_payload)

        if _is_buy_limit_entry(entry):
            if not positive_float(entry.get("original_value_usd")):
                _set_buy_original_once(
                    entry,
                    resolve_buy_original_value_usd(
                        raw_order=raw_order,
                        normalized=normalized,
                        place_payload=place_payload,
                    ),
                )
            if raw_order:
                _sync_buy_used_from_fill(entry, raw_order)

        _dedupe_orders_list_locked()
        return _finalize_order_entry(entry)


def orders_list_sync_from_coinbase(raw_orders):
    seen_coinbase_ids = set()

    for raw_order in raw_orders or []:
        normalized = normalize_order(raw_order)
        if normalized is None:
            continue

        coinbase_id = str(normalized.get("id") or "")
        if coinbase_id:
            seen_coinbase_ids.add(coinbase_id)

        orders_list_upsert_from_coinbase(normalized, raw_order=raw_order)

    with _orders_list_lock:
        kept = []
        for entry in _orders_list:
            status = str(entry.get("status") or "").upper()
            # FILLED must leave all orders — never retain a filled row.
            if status == "FILLED":
                continue

            coinbase_id = str(entry.get("coinbase_id") or "")
            entry_id = str(entry.get("id") or "")
            seen = (
                coinbase_id in seen_coinbase_ids
                or entry_id in seen_coinbase_ids
            )

            if seen:
                kept.append(entry)
                continue

            order_type = str(entry.get("order_type") or "").upper()
            # Filled markets leave Coinbase's open book instantly — never keep them.
            if order_type == "MARKET":
                continue
            # Trailing stop-limit fills must disappear — never retain a ghost.
            if order_type == "TRAILING_LIMIT":
                purge_trailing_limit_state(coinbase_id or entry_id)
                continue

            # Absence from one OPEN snapshot is not confirmation that an order closed.
            # Only an exact closed event or an explicit operation removes the row.
            kept.append(entry)

        _orders_list[:] = kept
        _dedupe_orders_list_locked()


def orders_list_drawable(product_id, all_products, trailing_orders):
    trailing_ids = {
        str(order.get("coinbase_order_id") or order.get("id") or "")
        for order in trailing_orders
        if order.get("coinbase_order_id") or order.get("id")
    }
    drawable = []

    with _orders_list_lock:
        # Drop any FILLED rows still stuck in all orders.
        _orders_list[:] = [
            entry
            for entry in _orders_list
            if str(entry.get("status") or "").upper() != "FILLED"
        ]
        for entry in _orders_list:
            coinbase_id = str(entry.get("id") or "")
            if coinbase_id in trailing_ids:
                continue
            # Instant MARKET fills are not resting open orders — never list them.
            if str(entry.get("order_type") or "").upper() == "MARKET":
                continue
            if not all_products and not order_applies_to_product(entry, product_id):
                continue
            drawable.append(order_public_view(entry))

    unique = {}
    for entry in drawable:
        original_id = str(entry.get("original_id") or entry.get("visualKey") or entry.get("id") or "")
        unique[original_id] = entry

    return list(unique.values())


def _stamp_entry_display_prices(entry, new_price, stop_price=None):
    if new_price is not None and new_price > 0:
        entry["price"] = new_price

    legs = entry.get("bracket_legs")
    if isinstance(legs, list) and legs:
        next_legs = []
        for leg in legs:
            if not isinstance(leg, dict):
                continue
            updated = dict(leg)
            role = str(updated.get("role") or "").lower()
            if role == "take_profit" and new_price is not None and new_price > 0:
                updated["price"] = new_price
            elif role == "stop_loss" and stop_price is not None and stop_price > 0:
                updated["price"] = stop_price
            next_legs.append(updated)
        entry["bracket_legs"] = next_legs
    elif stop_price is not None and stop_price > 0:
        entry["stop_price"] = stop_price


def orders_list_set_pending(order_ref, new_price, stop_price=None):
    """Stamp new display price immediately. Keep previous_price for a failed-move retry."""
    with _orders_list_lock:
        entry = _orders_find_locked(original_id=order_ref)
        if entry is None:
            return None
        if str(entry.get("status") or "").upper() == "PENDING":
            _stamp_entry_display_prices(entry, new_price, stop_price)
            return order_public_view(entry)

        if _is_buy_limit_entry(entry):
            # Freeze parent USED as the baseline for the next Coinbase child.
            used_now = positive_float(entry.get("used_value_usd")) or 0.0
            entry["used_before_current_order_usd"] = used_now

        entry["previous_price"] = entry.get("price")
        if stop_price is not None and stop_price > 0:
            old_stop = None
            for leg in entry.get("bracket_legs") or []:
                if isinstance(leg, dict) and str(leg.get("role") or "").lower() == "stop_loss":
                    old_stop = parse_order_price(leg.get("price"))
                    break
            if old_stop is None:
                old_stop = parse_order_price(entry.get("stop_price"))
            if old_stop and old_stop > 0:
                entry["previous_stop_price"] = old_stop

        entry["status"] = "PENDING"
        _stamp_entry_display_prices(entry, new_price, stop_price)
        return order_public_view(entry)


def orders_list_apply_edit_price(order_ref, new_price, size=None, stop_price=None):
    """Stamp a successful Coinbase edit onto the local row (OPEN at requested prices)."""
    with _orders_list_lock:
        entry = _orders_find_locked(original_id=order_ref)
        if entry is None:
            entry = _orders_find_locked(coinbase_id=order_ref)
        if entry is None:
            return None

        if new_price is not None and new_price > 0:
            entry["price"] = new_price

        entry["status"] = "OPEN"

        if size is not None and size > 0:
            entry["amount"] = size
            entry["base_size"] = size
            entry["total_base_size"] = size

        legs = entry.get("bracket_legs")
        if isinstance(legs, list) and legs:
            next_legs = []
            for leg in legs:
                if not isinstance(leg, dict):
                    continue
                updated = dict(leg)
                role = str(updated.get("role") or "").lower()
                if role == "take_profit" and new_price is not None and new_price > 0:
                    updated["price"] = new_price
                    amount = positive_float(updated.get("amount"))
                    # Edit success: stamp confirmed $ onto the leg for FE to read.
                    if amount and amount > 0:
                        updated["total_value"] = new_price * amount
                        updated["order_total"] = updated["total_value"]
                elif role == "stop_loss" and stop_price is not None and stop_price > 0:
                    updated["price"] = stop_price
                    amount = positive_float(updated.get("amount"))
                    if amount and amount > 0:
                        updated["total_value"] = stop_price * amount
                        updated["order_total"] = updated["total_value"]
                next_legs.append(updated)
            entry["bracket_legs"] = next_legs
            # Parent display $ follows confirmed TP leg after a successful edit.
            for leg in next_legs:
                if str(leg.get("role") or "").lower() == "take_profit":
                    tp_total = positive_float(leg.get("total_value") or leg.get("order_total"))
                    if tp_total and tp_total > 0:
                        entry["total_value"] = tp_total
                        entry["order_total"] = tp_total
                    break
        elif str(entry.get("order_type") or "").upper() == "BRACKET":
            amount = positive_float(entry.get("amount") or entry.get("base_size"))
            next_legs = []
            if new_price is not None and new_price > 0:
                next_legs.append({
                    "id": f"{entry.get('coinbase_id') or entry.get('id')}:take-profit",
                    "cancel_id": entry.get("coinbase_id") or entry.get("id"),
                    "role": "take_profit",
                    "side": entry.get("side"),
                    "price": new_price,
                    "amount": amount,
                    "total_value": (new_price * amount) if amount else None,
                })
            if stop_price is not None and stop_price > 0:
                next_legs.append({
                    "id": f"{entry.get('coinbase_id') or entry.get('id')}:stop-loss",
                    "cancel_id": entry.get("coinbase_id") or entry.get("id"),
                    "role": "stop_loss",
                    "side": entry.get("side"),
                    "price": stop_price,
                    "amount": amount,
                    "total_value": (stop_price * amount) if amount else None,
                })
            if next_legs:
                entry["bracket_legs"] = next_legs
        elif stop_price is not None and stop_price > 0:
            entry["stop_price"] = stop_price

        return order_public_view(entry)


def orders_list_revert_open(original_id):
    with _orders_list_lock:
        entry = _orders_find_locked(original_id=original_id)
        if entry is None:
            return None
        previous_price = parse_order_price(entry.get("previous_price"))
        if previous_price and previous_price > 0:
            entry["price"] = previous_price
        entry["status"] = "OPEN"
        return _finalize_order_entry(dict(entry))


def orders_list_transition_success(original_id, new_coinbase_id, new_price, normalized=None):
    with _orders_list_lock:
        entry = _orders_find_locked(original_id=original_id)
        if entry is None:
            return None

        # Parent dollars stay on original_id. Lock current USED as baseline for the new child.
        original_value_usd = positive_float(entry.get("original_value_usd"))
        used_value_usd = positive_float(entry.get("used_value_usd")) or 0.0
        remaining_value_usd = positive_float(entry.get("remaining_value_usd"))
        entry["id"] = str(new_coinbase_id)
        entry["coinbase_id"] = str(new_coinbase_id)
        entry["status"] = "OPEN"
        entry["price"] = new_price

        if isinstance(normalized, dict):
            # Never let child remaining quote overwrite parent ORIGINAL/USED.
            cleaned = {
                key: value
                for key, value in normalized.items()
                if key not in BUY_PARENT_DOLLAR_KEYS
            }
            entry.update(cleaned)
            entry["id"] = str(new_coinbase_id)
            entry["coinbase_id"] = str(new_coinbase_id)
            entry["original_id"] = original_id
            entry["status"] = "OPEN"
            entry["price"] = new_price

        # New Coinbase child starts empty — do not keep the previous child's fills.
        entry["filled_size"] = positive_float(
            (normalized or {}).get("filled_size") if isinstance(normalized, dict) else None
        ) or 0.0
        entry["child_filled_value_usd"] = 0.0
        entry.pop("average_filled_price", None)

        if original_value_usd:
            entry["original_value_usd"] = original_value_usd
        entry["used_before_current_order_usd"] = used_value_usd
        if original_value_usd:
            _apply_buy_used(entry, used_value_usd)
        elif remaining_value_usd is not None:
            entry["remaining_value_usd"] = remaining_value_usd
            entry["used_value_usd"] = used_value_usd
        else:
            entry["used_value_usd"] = used_value_usd
        _dedupe_orders_list_locked()
        return order_public_view(entry)


def orders_list_set_error(original_id):
    with _orders_list_lock:
        entry = _orders_find_locked(original_id=original_id)
        if entry is None:
            return None
        entry["status"] = "ERROR"
        return _finalize_order_entry(dict(entry))


def orders_list_remove(original_id):
    target = str(original_id or "")
    if not target:
        return False

    with _orders_list_lock:
        for index, entry in enumerate(_orders_list):
            if str(entry.get("original_id") or "") == target:
                _orders_list.pop(index)
                return True

    return False


def orders_list_apply_closed(coinbase_id):
    """Drop a Coinbase-closed order. Keep PENDING (BUY replace in flight) and ERROR."""
    target = str(coinbase_id or "")
    if not target:
        return False

    purge_trailing_limit_state(target)

    with _orders_list_lock:
        entry = _orders_find_locked(coinbase_id=target)
        if entry is None:
            return False

        entry_status = str(entry.get("status") or "OPEN").upper()
        if entry_status in ("PENDING", "ERROR"):
            return False

        original_id = str(entry.get("original_id") or "")
        _orders_list[:] = [
            candidate
            for candidate in _orders_list
            if str(candidate.get("original_id") or "") != original_id
            and str(candidate.get("id") or "") != target
        ]
        return True


def list_tracked_orders(product_id, all_products=False):
    normalized_product_id = str(product_id or PRODUCT_ID).upper()
    trailing_orders = [
        order
        for order in get_trailing_orders()
        if all_products or order_applies_to_product(order, normalized_product_id)
    ]
    return [
        *map(trailing_public_view, trailing_orders),
        *orders_list_drawable(normalized_product_id, all_products, trailing_orders),
    ]


def register_live_ws_client(websocket, send_lock):
    global live_ws_loop

    live_ws_loop = asyncio.get_running_loop()
    with live_ws_clients_lock:
        live_ws_clients.add((websocket, send_lock))


def unregister_live_ws_client(websocket, send_lock):
    with live_ws_clients_lock:
        live_ws_clients.discard((websocket, send_lock))


async def broadcast_orders_update(product_id=None):
    """Push current tracked orders snapshot to all /api/live clients."""
    resolved_product_id = str(product_id or PRODUCT_ID).upper()
    all_orders = list_tracked_orders(resolved_product_id, all_products=True)
    message = {
        "type": "orders_update",
        "event_id": hashlib.sha256(
            f"buy-replace-resolve:{time.time_ns()}:{resolved_product_id}".encode("utf-8")
        ).hexdigest(),
        "snapshot": True,
        "product_id": resolved_product_id,
        "all_orders": all_orders,
    }

    with live_ws_clients_lock:
        clients = list(live_ws_clients)

    disconnected = []
    for websocket, send_lock in clients:
        try:
            async with send_lock:
                await websocket.send_json(message)
        except Exception:
            disconnected.append((websocket, send_lock))

    if disconnected:
        with live_ws_clients_lock:
            for client in disconnected:
                live_ws_clients.discard(client)


def emit_orders_update(product_id=None):
    """Thread-safe orders_update broadcast (BUY replace bg and similar)."""
    loop = live_ws_loop
    if loop is None or not loop.is_running():
        return

    try:
        asyncio.run_coroutine_threadsafe(broadcast_orders_update(product_id), loop)
    except Exception as exc:
        print(f"EMIT ORDERS_UPDATE FAILED err={exc}", flush=True)


def _try_place_buy_limit(original_id, product_id, quote_size, price):
    client_order_id = secrets.token_hex(16)
    with _orders_list_lock:
        entry = _orders_find_locked(original_id=original_id)
        if entry is None or str(entry.get("status") or "").upper() != "PENDING":
            return None
        entry["client_order_id"] = client_order_id

    place_request = build_coinbase_order_request({
        "product_id": product_id,
        "side": "BUY",
        "order_type": "LIMIT",
        "quote_size": quote_size,
        "limit_price": price,
        "client_order_id": client_order_id,
    }, include_client_order_id=True)

    try:
        place_response = coinbase_advanced_post(
            "/api/v3/brokerage/orders",
            place_request["body"],
        )
    except HTTPException as exc:
        print(
            f"COINBASE BUY LIMIT PLACE HTTP FAILED product={product_id} "
            f"price={price} quote={quote_size} detail={exc.detail}",
            flush=True,
        )
        return None

    if place_response.get("success") is not True:
        detail = (
            place_response.get("failure_reason")
            or place_response.get("error_response")
            or place_response.get("order_failure_reason")
            or place_response
        )
        print(
            f"COINBASE BUY LIMIT PLACE REJECTED product={product_id} "
            f"price={price} quote={quote_size} detail={detail}",
            flush=True,
        )
        return None

    new_order_id = (
        (place_response.get("success_response") or {}).get("order_id")
        or place_response.get("order_id")
    )
    if not new_order_id:
        return None

    with _orders_list_lock:
        entry = _orders_find_locked(original_id=original_id)
        if entry is not None and str(entry.get("status") or "").upper() == "PENDING":
            entry["coinbase_id"] = str(new_order_id)
            entry["id"] = str(new_order_id)
            entry["status"] = "OPEN"

    return str(new_order_id)


def _cancel_failure_reason(exc):
    parts = [str(exc or "")]
    detail = getattr(exc, "detail", None)
    if detail is not None:
        parts.append(json.dumps(detail) if not isinstance(detail, str) else detail)
    return " ".join(parts).upper()


def _do_buy_limit_replace_bg(original_id, old_coinbase_id, product_id, new_price, original_price, remaining_quote):
    print(
        f"COINBASE BUY LIMIT REPLACE BG START original_id={original_id} "
        f"old={old_coinbase_id} product={product_id} new_price={new_price} "
        f"original_price={original_price} remaining={remaining_quote}",
        flush=True,
    )

    entry = orders_list_find(original_id=original_id)
    previous_price = parse_order_price(entry.get("previous_price") if entry else None)
    if previous_price is None or previous_price <= 0:
        previous_price = parse_order_price(original_price)

    cancel_already_gone = False
    try:
        cancel_data = coinbase_advanced_post(
            "/api/v3/brokerage/orders/batch_cancel",
            {"order_ids": [old_coinbase_id]},
        )
        cancel_result = (cancel_data.get("results") or [{}])[0]
        if not bool(cancel_result.get("success")):
            reason = str(
                cancel_result.get("failure_reason")
                or cancel_result.get("error")
                or "Cancel failed."
            )
            raise RuntimeError(reason)
    except Exception as exc:
        reason = _cancel_failure_reason(exc)
        print(
            f"COINBASE BUY LIMIT REPLACE BG CANCEL FAILED original_id={original_id} err={exc}",
            flush=True,
        )
        if _cancel_already_gone_reason(reason):
            cancel_already_gone = True
        else:
            # Cancel failed and order should still exist on Coinbase — restore OPEN.
            orders_list_revert_open(original_id)
            clear_account_caches()
            emit_orders_update(product_id)
            return

    if cancel_already_gone:
        print(
            f"COINBASE BUY LIMIT REPLACE BG CANCEL ALREADY GONE original_id={original_id} "
            f"continuing to place remaining={remaining_quote}",
            flush=True,
        )

    # 1) Place at the new price with REMAINING $.
    new_order_id = _try_place_buy_limit(
        original_id,
        product_id,
        remaining_quote,
        new_price,
    )
    placed_price = new_price

    # 2) If that fails — place at the previous price with REMAINING $.
    if not new_order_id:
        if previous_price and previous_price > 0:
            print(
                f"COINBASE BUY LIMIT REPLACE BG RETRY PREVIOUS PRICE "
                f"original_id={original_id} price={previous_price} remaining={remaining_quote}",
                flush=True,
            )
            new_order_id = _try_place_buy_limit(
                original_id,
                product_id,
                remaining_quote,
                previous_price,
            )
            if new_order_id:
                placed_price = previous_price

    # 3) Only ERROR after previous-price place also fails.
    if not new_order_id:
        print(f"COINBASE BUY LIMIT REPLACE BG ERROR original_id={original_id}", flush=True)
        orders_list_set_error(original_id)
        clear_account_caches()
        emit_orders_update(product_id)
        return

    normalized_order = None
    raw_placed = None

    try:
        order_data = coinbase_advanced_get(f"/api/v3/brokerage/orders/historical/{new_order_id}")
        raw_placed = order_data.get("order") or order_data
        normalized_order = normalize_order(raw_placed)
    except HTTPException:
        normalized_order = None

    if normalized_order is None:
        estimated_base = remaining_quote / placed_price if placed_price > 0 else None
        normalized_order = {
            "id": new_order_id,
            "product_id": product_id,
            "side": "buy",
            "price": placed_price,
            "amount": estimated_base,
            "base_size": estimated_base,
            "total_base_size": estimated_base,
            "quote_size": remaining_quote,
            "filled_percent": 0,
            "bracket_legs": [],
            "status": "OPEN",
            "order_type": "LIMIT",
        }

    orders_list_transition_success(
        original_id,
        new_order_id,
        placed_price,
        normalized=normalized_order,
    )
    if raw_placed:
        entry = orders_list_find(original_id=original_id)
        if entry:
            orders_list_upsert_from_coinbase(entry, raw_order=raw_placed)

    clear_account_caches()
    emit_orders_update(product_id)
    print(
        f"COINBASE BUY LIMIT REPLACE BG OK original_id={original_id} "
        f"new_order_id={new_order_id} price={placed_price}",
        flush=True,
    )


def fetch_open_orders_raw():
    data = coinbase_advanced_get(
        "/api/v3/brokerage/orders/historical/batch",
        {
            "order_status": ["OPEN"],
        },
    )
    return data.get("orders", [])


def get_cached_open_orders_raw(force=False):
    if force:
        with orders_cache_lock:
            starting_generation = int(orders_cache.get("force_generation") or 0)

        with orders_refresh_lock:
            with orders_cache_lock:
                raw_orders = orders_cache.get("raw_orders")
                force_generation = int(orders_cache.get("force_generation") or 0)

                # A concurrent forced request already refreshed this data.
                if raw_orders is not None and force_generation != starting_generation:
                    return raw_orders

            raw_orders = fetch_open_orders_raw()
            with orders_cache_lock:
                orders_cache["raw_orders"] = raw_orders
                orders_cache["time"] = time.monotonic()
                orders_cache["force_generation"] = (
                    int(orders_cache.get("force_generation") or 0) + 1
                )
            return raw_orders

    now = time.monotonic()

    with orders_cache_lock:
        raw_orders = orders_cache.get("raw_orders")
        cached_at = float(orders_cache.get("time") or 0)

        if (
            raw_orders is not None
            and now - cached_at < ORDERS_CACHE_SECONDS
        ):
            return raw_orders

    with orders_refresh_lock:
        now = time.monotonic()

        with orders_cache_lock:
            raw_orders = orders_cache.get("raw_orders")
            cached_at = float(orders_cache.get("time") or 0)

            if (
                raw_orders is not None
                and now - cached_at < ORDERS_CACHE_SECONDS
            ):
                return raw_orders

        raw_orders = fetch_open_orders_raw()

        with orders_cache_lock:
            orders_cache["raw_orders"] = raw_orders
            orders_cache["time"] = time.monotonic()

        return raw_orders


def _cancel_already_gone_reason(reason):
    text = str(reason or "").upper()
    markers = (
        "UNKNOWN_CANCEL_ORDER",
        "UNKNOWN_ORDER",
        "NOT_FOUND",
        "ORDER_IS_FILLED",
        "ORDER_ALREADY",
        "FILLED",
        "CANCELLED",
        "CANCELED",
        "EXPIRED",
        "DOES_NOT_EXIST",
        "NO_SUCH",
        "INVALID_ORDER_ID",
    )
    return any(marker in text for marker in markers)


def _cancel_result_reason(result=None, exc=None):
    parts = []
    if isinstance(result, dict):
        for key in ("failure_reason", "error", "message"):
            value = result.get(key)
            if value is not None:
                parts.append(value)
        error_response = result.get("error_response")
        if isinstance(error_response, dict):
            for key in ("error", "message", "error_details", "preview_failure_reason"):
                value = error_response.get(key)
                if value is not None:
                    parts.append(value)
        elif error_response is not None:
            parts.append(error_response)
    if exc is not None:
        parts.append(_cancel_failure_reason(exc))
    return " ".join(str(part) for part in parts if part not in (None, ""))


def _coinbase_order_still_open(coinbase_id):
    """True=still open, False=gone/filled/closed, None=could not check."""
    target = str(coinbase_id or "").strip()
    if not target or target.startswith("order-"):
        return False

    try:
        order_data = coinbase_advanced_get(f"/api/v3/brokerage/orders/historical/{target}")
        raw_order = order_data.get("order") or order_data
    except HTTPException as exc:
        if int(getattr(exc, "status_code", 0) or 0) in (400, 404):
            return False
        return None

    if not isinstance(raw_order, dict):
        return False

    return is_open_order_status(raw_order.get("status"))


def _remove_tracked_order(tracked, order_id):
    local_id = str((tracked or {}).get("original_id") or order_id or "")
    coinbase_id = tracked_coinbase_id(tracked) if tracked else None
    if coinbase_id:
        purge_trailing_limit_state(coinbase_id)
    if local_id:
        orders_list_remove(local_id)
    if coinbase_id:
        with _orders_list_lock:
            _orders_list[:] = [
                entry
                for entry in _orders_list
                if str(entry.get("coinbase_id") or "") != str(coinbase_id)
                and str(entry.get("id") or "") != str(coinbase_id)
            ]
    return local_id or order_id


@app.post("/api/orders/cancel")
@coinbase_worker_endpoint(lane="interactive")
def cancel_order(
    original_id: Annotated[str, Query()],
):
    order_id = str(original_id or "").strip()
    if not order_id:
        raise HTTPException(status_code=400, detail="original_id is required.")

    if str(order_id).startswith("trailing-"):
        cancel_trailing_order(order_id)
        clear_orders_cache()
        return {
            "original_id": order_id,
            "success": True,
            "removed": True,
        }

    tracked = orders_list_find(original_id=order_id)
    local_id = str((tracked or {}).get("original_id") or order_id)
    coinbase_id = tracked_coinbase_id(tracked) if tracked else None

    def finish_removed(*, already_gone=False):
        _remove_tracked_order(tracked, local_id)
        clear_account_caches()
        print(
            f"ORDERS LIST REMOVE AFTER CANCEL original_id={local_id} "
            f"coinbase={coinbase_id or ''} already_gone={already_gone}",
            flush=True,
        )
        return {
            "original_id": local_id,
            "success": True,
            "removed": True,
            "already_gone": already_gone,
        }

    # ERROR / no Coinbase order left → just drop the local row.
    if tracked and str(tracked.get("status") or "").upper() == "ERROR":
        return finish_removed(already_gone=True)

    if not coinbase_id or str(coinbase_id).startswith("order-"):
        return finish_removed(already_gone=True)

    result = {}
    success = False
    failure_reason = ""
    try:
        data = coinbase_advanced_post(
            "/api/v3/brokerage/orders/batch_cancel",
            {
                "order_ids": [coinbase_id],
            },
        )
        results = data.get("results", [])
        result = results[0] if results else {}
        success = bool(result.get("success"))
        failure_reason = _cancel_result_reason(result)
    except HTTPException as exc:
        failure_reason = _cancel_result_reason(exc=exc)
        print(
            f"COINBASE CANCEL FAILED order_id={coinbase_id} status={exc.status_code} detail={exc.detail}",
            flush=True,
        )
        if not (
            _cancel_already_gone_reason(failure_reason)
            or _coinbase_order_still_open(coinbase_id) is False
        ):
            raise

    print(
        f"COINBASE CANCEL {'OK' if success else 'FAILED'} "
        f"order_id={coinbase_id} "
        f"failure_reason={failure_reason or ''}",
        flush=True,
    )

    if success:
        return finish_removed(already_gone=False)

    # Cancel rejected: if Coinbase has no open order (filled/gone), drop the row.
    if _cancel_already_gone_reason(failure_reason):
        return finish_removed(already_gone=True)

    still_open = _coinbase_order_still_open(coinbase_id)
    if still_open is False:
        return finish_removed(already_gone=True)

    raise HTTPException(
        status_code=400,
        detail=failure_reason or "Coinbase did not cancel the order.",
    )


def get_open_buy_limit_notional(raw_order):
    if not isinstance(raw_order, dict):
        return None

    if str(raw_order.get("side") or "").upper() != "BUY":
        return None

    configuration = raw_order.get("order_configuration") or {}
    if not isinstance(configuration.get("limit_limit_gtc"), dict):
        return None

    config = configuration["limit_limit_gtc"]
    quote_size = positive_float(config.get("quote_size"))
    base_size = positive_float(config.get("base_size"))
    old_price = parse_order_price(config.get("limit_price"))
    leaves = positive_float(raw_order.get("leaves_quantity"))
    filled = positive_float(raw_order.get("filled_size")) or 0

    remaining_base = leaves
    if remaining_base is None and base_size is not None:
        remaining_base = base_size - filled
        if remaining_base <= 0:
            remaining_base = None

    if quote_size is not None:
        if filled > 0 and old_price is not None and old_price > 0:
            return max(0.0, quote_size - (filled * old_price))
        return quote_size

    if remaining_base is not None and old_price is not None and old_price > 0:
        return remaining_base * old_price

    if base_size is not None and old_price is not None and old_price > 0:
        return base_size * old_price

    return None


def replace_buy_limit_order(order_id, product_id, price, fallback_size):
    """Mark BUY limit PENDING and return immediately; cancel/replace runs in background."""
    tracked = orders_list_find(original_id=order_id)
    if tracked is None:
        raise HTTPException(status_code=404, detail={
            "message": "original_id was not found.",
            "original_id": order_id,
            "status": "NOT_FOUND",
        })

    original_id = str(tracked.get("original_id") or "")
    coinbase_id = tracked_coinbase_id(tracked)
    if not original_id or not coinbase_id:
        raise HTTPException(status_code=409, detail={
            "message": "Order has no active Coinbase order.",
            "original_id": original_id or order_id,
            "status": str(tracked.get("status") or "OPEN").upper(),
        })

    # Display values and PENDING first. Do not upsert this row from Coinbase while in flight.
    pending_order = orders_list_set_pending(original_id, price)

    try:
        order_data = coinbase_advanced_get(f"/api/v3/brokerage/orders/historical/{coinbase_id}")
        raw_order = order_data.get("order") or order_data
    except HTTPException:
        raw_order = None

    if not isinstance(raw_order, dict):
        raise HTTPException(status_code=400, detail="Unable to load buy limit order for replace.")

    if str(raw_order.get("side") or "").upper() != "BUY":
        raise HTTPException(status_code=400, detail="Buy-limit replace requires a BUY order.")

    configuration = raw_order.get("order_configuration") or {}
    if not isinstance(configuration.get("limit_limit_gtc"), dict):
        raise HTTPException(status_code=400, detail="Buy-limit replace requires an open LIMIT order.")

    if price is None or price <= 0:
        raise HTTPException(status_code=400, detail="price must be positive.")

    resolved_product_id = str(raw_order.get("product_id") or product_id or PRODUCT_ID).upper()
    original_price = parse_order_price(configuration["limit_limit_gtc"].get("limit_price"))

    original_value = positive_float(tracked.get("original_value_usd"))
    used_value = positive_float(tracked.get("used_value_usd")) or 0.0
    remaining_quote = None
    if original_value and original_value > 0:
        remaining_quote = max(0.0, original_value - used_value)

    if remaining_quote is None or remaining_quote <= 0:
        remaining_quote = positive_float(tracked.get("remaining_value_usd"))

    if remaining_quote is None or remaining_quote <= 0:
        remaining_quote = get_open_buy_limit_notional(raw_order)

    if remaining_quote is None or remaining_quote <= 0:
        if fallback_size is not None and fallback_size > 0 and price > 0:
            remaining_quote = fallback_size * price

    if remaining_quote is None or remaining_quote <= 0:
        raise HTTPException(status_code=400, detail="quote_size must be positive.")

    if pending_order is None:
        pending_entry = orders_list_find(original_id=original_id)
        pending_order = order_public_view(pending_entry) if pending_entry else None
    if pending_order is not None:
        pending_order["price"] = price
        pending_order["status"] = "PENDING"

    Thread(
        target=_do_buy_limit_replace_bg,
        args=(
            original_id,
            coinbase_id,
            resolved_product_id,
            price,
            original_price,
            remaining_quote,
        ),
        daemon=True,
    ).start()

    print(
        f"COINBASE BUY LIMIT REPLACE PENDING original_id={original_id} "
        f"order_id={coinbase_id} price={price} remaining={remaining_quote}",
        flush=True,
    )

    return {
        "success": True,
        "replaced": True,
        "pending": True,
        "original_id": original_id,
        "order": pending_order or order_public_view(tracked),
    }


def resolve_coinbase_edit_total_size(tracked, raw_order, requested_size=None):
    """Coinbase edit `size` is new TOTAL (>= filled). Never remaining/leaves alone."""
    tracked = tracked if isinstance(tracked, dict) else {}
    raw_order = raw_order if isinstance(raw_order, dict) else {}
    config = parse_order_configuration(raw_order) if raw_order else {}

    filled = (
        positive_float(raw_order.get("filled_size") or raw_order.get("cumulative_quantity"))
        or positive_float(tracked.get("filled_size"))
        or 0.0
    )
    leaves = (
        positive_float(raw_order.get("leaves_quantity"))
        or positive_float(tracked.get("leaves_quantity"))
    )
    config_base = parse_order_base_size(raw_order, config) if raw_order else None

    totals = []
    if config_base and config_base > 0:
        totals.append(config_base)
    for source in (tracked, raw_order):
        total = positive_float(source.get("total_base_size"))
        if total and total > 0:
            totals.append(total)
    if filled and leaves is not None and (filled + leaves) > 0:
        totals.append(filled + leaves)
    for source in (tracked, raw_order):
        base = positive_float(source.get("base_size"))
        if base and base > 0 and base >= filled:
            totals.append(base)

    requested = positive_float(requested_size)
    if requested and requested > 0 and requested >= filled:
        totals.append(requested)

    size = next((candidate for candidate in totals if candidate and candidate > 0), None)
    if size is None and filled > 0:
        size = filled
    if size is not None and filled > 0 and size < filled:
        size = filled

    return size


def format_edit_size_for_increment(size, increment, filled=None):
    formatted = format_decimal_for_increment(size, increment)
    numeric = positive_float(formatted)
    filled_size = positive_float(filled) or 0.0

    if filled_size > 0 and (numeric is None or numeric < filled_size):
        numeric_value = parse_decimal(max(size or 0, filled_size))
        numeric_increment = parse_decimal(increment)
        if numeric_value is None:
            return formatted
        if numeric_increment is None or numeric_increment <= 0:
            return format(numeric_value.normalize(), "f")
        rounded = numeric_value.quantize(numeric_increment, rounding=ROUND_UP)
        return format(rounded, "f")

    return formatted


def _try_coinbase_order_edit(
    coinbase_id,
    *,
    price,
    size,
    stop_price,
    quote_increment,
    base_increment,
    filled_size,
):
    body = {
        "order_id": coinbase_id,
        "price": format_decimal_for_increment(price, quote_increment),
        "size": format_edit_size_for_increment(size, base_increment, filled_size),
    }
    if stop_price is not None and stop_price > 0:
        body["stop_price"] = format_decimal_for_increment(stop_price, quote_increment)

    print(
        f"COINBASE EDIT ORDER REQUEST order_id={coinbase_id} body={json.dumps(body)}",
        flush=True,
    )

    try:
        response = coinbase_advanced_post("/api/v3/brokerage/orders/edit", body)
    except HTTPException as exc:
        print(
            f"COINBASE EDIT ORDER FAILED order_id={coinbase_id} "
            f"status={exc.status_code} detail={exc.detail}",
            flush=True,
        )
        return False

    if response.get("success") is not True:
        detail = (
            response.get("error_response")
            or response.get("failure_reason")
            or response.get("errors")
            or "Coinbase rejected the edit."
        )
        print(
            f"COINBASE EDIT ORDER REJECTED order_id={coinbase_id} detail={detail}",
            flush=True,
        )
        return False

    return True
    formatted = format_decimal_for_increment(size, increment)
    numeric = positive_float(formatted)
    filled_size = positive_float(filled) or 0.0

    if filled_size > 0 and (numeric is None or numeric < filled_size):
        numeric_value = parse_decimal(max(size or 0, filled_size))
        numeric_increment = parse_decimal(increment)
        if numeric_value is None:
            return formatted
        if numeric_increment is None or numeric_increment <= 0:
            return format(numeric_value.normalize(), "f")
        rounded = numeric_value.quantize(numeric_increment, rounding=ROUND_UP)
        return format(rounded, "f")

    return formatted


@app.post("/api/orders/edit")
@coinbase_worker_endpoint(lane="interactive")
def edit_order(order: dict):
    order_id = str(order.get("original_id") or "").strip()
    price = parse_order_price(order.get("price"))
    stop_price = parse_order_price(order.get("stop_price"))
    requested_size = positive_float(order.get("size") or order.get("base_size"))

    if not order_id:
        raise HTTPException(status_code=400, detail="original_id is required.")
    if str(order_id).startswith("trailing-"):
        raise HTTPException(status_code=400, detail="Trailing orders cannot be edited via Coinbase.")
    if price is None or price <= 0:
        raise HTTPException(status_code=400, detail="price must be positive.")

    tracked = orders_list_find(original_id=order_id)
    if tracked is None:
        raise HTTPException(status_code=404, detail={
            "message": "original_id was not found.",
            "original_id": order_id,
            "status": "NOT_FOUND",
        })

    tracked_status = str(tracked.get("status") or "OPEN").upper()
    if tracked_status in ("PENDING", "ERROR"):
        raise HTTPException(status_code=409, detail={
            "message": f"Order cannot be edited while status is {tracked_status}.",
            "original_id": order_id,
            "status": tracked_status,
        })

    coinbase_id = tracked_coinbase_id(tracked) if tracked else None
    if not coinbase_id:
        raise HTTPException(status_code=409, detail={
            "message": "Order has no active Coinbase order.",
            "original_id": order_id,
            "status": tracked_status,
        })

    raw_order = None
    try:
        order_data = coinbase_advanced_get(f"/api/v3/brokerage/orders/historical/{coinbase_id}")
        raw_order = order_data.get("order") or order_data
    except HTTPException:
        raw_order = None

    product_id = str(
        order.get("product_id")
        or (tracked or {}).get("product_id")
        or (raw_order or {}).get("product_id")
        or PRODUCT_ID
    ).upper()

    filled_size = (
        positive_float((raw_order or {}).get("filled_size") or (raw_order or {}).get("cumulative_quantity"))
        if isinstance(raw_order, dict)
        else None
    )
    if filled_size is None and isinstance(tracked, dict):
        filled_size = positive_float(tracked.get("filled_size"))

    leaves_size = None
    if isinstance(raw_order, dict):
        leaves_size = positive_float(raw_order.get("leaves_quantity"))
    if leaves_size is None and isinstance(tracked, dict):
        leaves_size = positive_float(tracked.get("leaves_quantity"))

    buy_fallback_size = requested_size or leaves_size
    size = resolve_coinbase_edit_total_size(tracked, raw_order, requested_size)

    if (
        isinstance(raw_order, dict)
        and str(raw_order.get("side") or "").upper() == "BUY"
        and isinstance((raw_order.get("order_configuration") or {}).get("limit_limit_gtc"), dict)
    ):
        return replace_buy_limit_order(order_id, product_id, price, buy_fallback_size)

    if size is None or size <= 0:
        raise HTTPException(status_code=400, detail="Unable to resolve order size for edit.")

    if stop_price is not None and stop_price <= 0:
        raise HTTPException(status_code=400, detail="stop_price must be positive.")

    product_metadata = get_product_metadata(product_id)
    quote_increment = (
        product_metadata.get("quote_increment")
        or product_metadata.get("quote_min_size")
        or "0.00000001"
    )
    base_increment = (
        product_metadata.get("base_increment")
        or product_metadata.get("base_min_size")
        or "0.00000001"
    )
    local_id = (tracked or {}).get("original_id") or order_id
    previous_price = parse_order_price(tracked.get("price"))
    previous_stop = parse_order_price(tracked.get("stop_price"))
    for leg in tracked.get("bracket_legs") or []:
        if isinstance(leg, dict) and str(leg.get("role") or "").lower() == "stop_loss":
            previous_stop = parse_order_price(leg.get("price")) or previous_stop
            break

    orders_list_set_pending(local_id, price, stop_price=stop_price)

    edit_kwargs = {
        "size": size,
        "quote_increment": quote_increment,
        "base_increment": base_increment,
        "filled_size": filled_size,
    }
    edited = _try_coinbase_order_edit(
        coinbase_id,
        price=price,
        stop_price=stop_price,
        **edit_kwargs,
    )
    placed_price = price
    placed_stop = stop_price
    if not edited and previous_price and previous_price > 0:
        retry_stop = previous_stop if stop_price is not None else None
        edited = _try_coinbase_order_edit(
            coinbase_id,
            price=previous_price,
            stop_price=retry_stop,
            **edit_kwargs,
        )
        if edited:
            placed_price = previous_price
            placed_stop = retry_stop

    if not edited:
        orders_list_set_error(local_id)
        clear_orders_cache()
        raise HTTPException(status_code=400, detail="Coinbase rejected the edit.")

    # Prefer stamping the requested edit prices — Coinbase historical can lag.
    stamped = orders_list_apply_edit_price(
        local_id,
        placed_price,
        size=size,
        stop_price=placed_stop,
    )
    if stamped is None and coinbase_id:
        stamped = orders_list_apply_edit_price(
            coinbase_id,
            placed_price,
            size=size,
            stop_price=placed_stop,
        )

    normalized_order = stamped
    if normalized_order is None:
        try:
            order_data = coinbase_advanced_get(f"/api/v3/brokerage/orders/historical/{coinbase_id}")
            raw_order = order_data.get("order") or order_data
            normalized = normalize_order(raw_order)
            if normalized is not None:
                normalized["price"] = placed_price
                normalized["status"] = "OPEN"
                if placed_stop is not None and placed_stop > 0:
                    legs = []
                    for leg in normalized.get("bracket_legs") or []:
                        if not isinstance(leg, dict):
                            continue
                        updated = dict(leg)
                        role = str(updated.get("role") or "").lower()
                        if role == "take_profit":
                            updated["price"] = placed_price
                        elif role == "stop_loss":
                            updated["price"] = placed_stop
                        legs.append(updated)
                    if legs:
                        normalized["bracket_legs"] = legs
                    else:
                        normalized["stop_price"] = placed_stop
                tracked_order = orders_list_upsert_from_coinbase(normalized, raw_order=raw_order)
                if tracked_order is not None:
                    stamped = orders_list_apply_edit_price(
                        tracked_order.get("original_id") or local_id,
                        placed_price,
                        size=size,
                        stop_price=placed_stop,
                    )
                    normalized_order = stamped or order_public_view(tracked_order)
        except HTTPException:
            normalized_order = None

    print(f"COINBASE EDIT ORDER OK order_id={coinbase_id}", flush=True)

    # Manual stop edits must update trailing-limit memory or the monitor will overwrite them.
    sync_trailing_limit_after_manual_edit(
        coinbase_id,
        stop_price=placed_stop,
        price=placed_price,
    )

    clear_orders_cache()

    return {
        "success": True,
        "original_id": local_id,
        "order": normalized_order,
    }


@app.post("/api/orders/place")
@coinbase_worker_endpoint(lane="interactive")
def place_order(order: dict):
    if normalize_trailing_order_type(order.get("order_type")) is not None:
        trailing_order = create_trailing_order(order)
        clear_orders_cache()
        public_order = trailing_public_view(trailing_order)
        return {
            "success": True,
            "original_id": public_order["original_id"],
            "order": public_order,
        }

    place_payload = dict(order or {})

    order_request = build_coinbase_order_request(place_payload, include_client_order_id=True)
    body = order_request["body"]
    product_id = order_request["product_id"]
    side = order_request["side"]
    order_type = order_request["order_type"]
    order_configuration = order_request["order_configuration"]

    print(
        f"COINBASE PLACE ORDER REQUEST product={product_id} side={side} type={order_type} "
        f"config={json.dumps(order_configuration)}",
        flush=True,
    )

    try:
        response = coinbase_advanced_post("/api/v3/brokerage/orders", body)
    except HTTPException as exc:
        print(
            f"COINBASE PLACE ORDER FAILED product={product_id} side={side} type={order_type} "
            f"status={exc.status_code} detail={exc.detail}",
            flush=True,
        )
        raise

    if response.get("success") is not True:
        detail = (
            response.get("failure_reason")
            or response.get("error_response")
            or response.get("order_failure_reason")
            or "Coinbase rejected the order."
        )
        print(
            f"COINBASE PLACE ORDER REJECTED product={product_id} side={side} type={order_type} detail={detail}",
            flush=True,
        )
        raise HTTPException(status_code=400, detail=detail)

    print(
        f"COINBASE PLACE ORDER OK product={product_id} side={side} type={order_type}",
        flush=True,
    )

    order_id = (
        (response.get("success_response") or {}).get("order_id")
        or response.get("order_id")
    )
    normalized_order = None

    if order_id:
        try:
            order_data = coinbase_advanced_get(f"/api/v3/brokerage/orders/historical/{order_id}")
            raw_order = order_data.get("order") or order_data
            normalized_order = normalize_order(raw_order)

            if normalized_order is not None and positive_float(normalized_order.get("amount")) is None:
                normalized_order = fill_order_sizes_from_preview(normalized_order, raw_order)
        except HTTPException:
            normalized_order = None

    if normalized_order is None:
        normalized_order = build_normalized_from_place_payload(
            order_id,
            product_id,
            side.lower(),
            order_type,
            place_payload,
        )
    else:
        normalized_order = apply_place_payload_fields(normalized_order, place_payload)

    if normalized_order is not None:
        raw_order = None
        if order_id:
            try:
                order_data = coinbase_advanced_get(f"/api/v3/brokerage/orders/historical/{order_id}")
                raw_order = order_data.get("order") or order_data
            except HTTPException:
                raw_order = None

        tracked_order = orders_list_upsert_from_coinbase(
            normalized_order,
            raw_order=raw_order,
            place_payload=place_payload,
        )
        public_order = None
        if tracked_order is not None:
            public_order = order_public_view(tracked_order)
            normalized_order = public_order

        response = {
            "success": True,
            "original_id": public_order.get("original_id") if public_order else None,
            "order": normalized_order,
        }

    clear_account_caches()

    return response


SOFT_PREVIEW_ERRORS = frozenset({
    "PREVIEW_INSUFFICIENT_FUND",
    "PREVIEW_INSUFFICIENT_FUNDS",
    "PREVIEW_INSUFFICIENT_FUNDS_FOR_ORDER",
})


def normalize_preview_response(response):
    if not isinstance(response, dict):
        return response

    normalized = dict(response)

    for field in ("base_size", "quote_size", "order_total", "commission_total"):
        value = positive_float(response.get(field))

        if value is not None:
            normalized[field] = value

    return normalized


@app.post("/api/orders/preview")
@coinbase_worker_endpoint(lane="interactive")
def preview_order(order: dict):
    trailing_order_type = normalize_trailing_order_type(order.get("order_type"))

    if trailing_order_type is not None:
        side = str(order.get("side") or "").upper()
        trail_percent = positive_float(order.get("trail_percent"))
        base_size = positive_float(order.get("base_size"))

        if side != "SELL":
            raise HTTPException(status_code=400, detail="Trailing is only enabled for SELL.")
        if base_size is None:
            raise HTTPException(status_code=400, detail="Trailing requires a positive base_size.")
        if trail_percent is None or trail_percent >= 100:
            raise HTTPException(
                status_code=400,
                detail="Trail percent must be greater than 0 and below 100.",
            )

        preview_order = {
            "product_id": order.get("product_id"),
            "side": "SELL",
            "order_type": "MARKET",
            "base_size": base_size,
        }

        if trailing_order_type == "TRAILING_LIMIT":
            market_price = get_product_ticker_price(order.get("product_id"))
            initial_stop_price = market_price * (1 - trail_percent / 100)
            preview_order["order_type"] = "STOP_LIMIT"
            preview_order["limit_price"] = initial_stop_price
            preview_order["stop_price"] = initial_stop_price

        trailing_request = build_coinbase_order_request(
            preview_order,
            include_client_order_id=False,
        )
        response = coinbase_advanced_post(
            "/api/v3/brokerage/orders/preview",
            trailing_request["body"],
        )
        return {
            **normalize_preview_response(response),
            "synthetic_order_type": trailing_order_type,
        }

    order_request = build_coinbase_order_request(order, include_client_order_id=False)
    body = order_request["body"]
    product_id = order_request["product_id"]
    side = order_request["side"]
    order_type = order_request["order_type"]
    order_configuration = order_request["order_configuration"]

    print(
        f"COINBASE PREVIEW ORDER REQUEST product={product_id} side={side} type={order_type} "
        f"config={json.dumps(order_configuration)}",
        flush=True,
    )

    try:
        response = coinbase_advanced_post("/api/v3/brokerage/orders/preview", body)
    except HTTPException as exc:
        print(
            f"COINBASE PREVIEW ORDER FAILED product={product_id} side={side} type={order_type} "
            f"status={exc.status_code} detail={exc.detail}",
            flush=True,
        )
        raise

    errs = response.get("errs") or []

    if errs:
        hard_errs = [err for err in errs if err not in SOFT_PREVIEW_ERRORS]

        if hard_errs:
            print(
                f"COINBASE PREVIEW ORDER REJECTED product={product_id} side={side} type={order_type} errs={hard_errs}",
                flush=True,
            )
            raise HTTPException(status_code=400, detail={"errs": hard_errs, "preview": response})

        print(
            f"COINBASE PREVIEW ORDER SOFT ERROR product={product_id} side={side} type={order_type} errs={errs}",
            flush=True,
        )

    else:
        print(
            f"COINBASE PREVIEW ORDER OK product={product_id} side={side} type={order_type}",
            flush=True,
        )

    return {
        **normalize_preview_response(response),
        "product_id": product_id,
        "side": side,
        "order_type": order_type,
        "order_configuration": order_configuration,
    }


def fetch_balances(force_prices=False):
    if force_prices:
        clear_usd_price_cache()

    try:
        accounts = []
        cursor = None

        while True:
            params = {"limit": 250}

            if cursor:
                params["cursor"] = cursor

            data = coinbase_advanced_get("/api/v3/brokerage/accounts", params)
            accounts.extend(data.get("accounts", []))

            cursor = data.get("cursor")

            if not data.get("has_next") or not cursor:
                break
    except HTTPException as exc:
        print(
            f"COINBASE BALANCES FAILED status={exc.status_code} detail={exc.detail}",
            flush=True,
        )
        return {
            "balances": [],
            "total_usd": 0,
            "priced_total": 0,
            "unpriced_total": 0,
            "error": exc.detail,
        }

    balances = []
    total_usd = 0.0
    priced_total = 0
    unpriced_total = 0

    for account in accounts:
        currency = str(account.get("currency") or "").upper()
        available = parse_balance_value(account.get("available_balance"))
        hold = parse_balance_value(account.get("hold"))

        if not currency:
            continue

        available = available if available is not None else 0.0
        hold = hold if hold is not None else 0.0
        total = available + hold

        if total <= 0 and currency != "USDC":
            continue

        usd_price = get_usd_price_for_currency(currency, force=force_prices)
        usd_value = total * usd_price if usd_price is not None else None

        if usd_value is None:
            unpriced_total += 1
        else:
            total_usd += usd_value
            priced_total += 1

        balances.append({
            "currency": currency,
            "available": available,
            "hold": hold,
            "total": total,
            "usd_price": usd_price,
            "usd_value": usd_value,
            "product_id": f"{currency}-USD" if currency not in USD_PEGGED_CURRENCIES else None,
        })

    if not any(balance["currency"] == "USDC" for balance in balances):
        balances.append({
            "currency": "USDC",
            "available": 0.0,
            "hold": 0.0,
            "total": 0.0,
            "usd_price": 1.0,
            "usd_value": 0.0,
            "product_id": None,
        })

    existing_currencies = {balance["currency"] for balance in balances}

    try:
        bookmark_currencies = list(
            ((read_app_state().get("yzTrade") or {}).get("bookmarks") or {}).keys()
        )
    except Exception:
        bookmark_currencies = []

    for raw_currency in bookmark_currencies:
        currency = str(raw_currency or "").upper()

        if (
            not currency
            or currency in existing_currencies
            or currency in USD_PEGGED_CURRENCIES
        ):
            continue

        usd_price = get_usd_price_for_currency(currency, force=force_prices)
        balances.append({
            "currency": currency,
            "available": 0.0,
            "hold": 0.0,
            "total": 0.0,
            "usd_price": usd_price,
            "usd_value": 0.0,
            "product_id": f"{currency}-USD",
        })
        existing_currencies.add(currency)

    pinned_currency_order = {
        "USD": 0,
        "USDC": 1,
    }

    balances.sort(
        key=lambda balance: (
            pinned_currency_order.get(balance["currency"], 99),
            balance["usd_value"] is None,
            -(balance["usd_value"] or 0),
            balance["currency"],
        )
    )

    print(
        "COINBASE BALANCES OK "
        f"accounts={len(accounts)} "
        f"balances={len(balances)} "
        f"priced={priced_total} "
        f"unpriced={unpriced_total} "
        f"total_usd={total_usd:.2f} "
        f"force_prices={bool(force_prices)}",
        flush=True,
    )

    record_balance_history_point(total_usd)

    return {
        "total_usd": total_usd,
        "priced_total": priced_total,
        "unpriced_total": unpriced_total,
        "balances": balances,
    }


def get_cached_balances(force_prices=False):
    if force_prices:
        with balances_cache_lock:
            starting_generation = int(balances_cache.get("force_generation") or 0)

        with balances_refresh_lock:
            with balances_cache_lock:
                payload = balances_cache.get("payload")
                force_generation = int(balances_cache.get("force_generation") or 0)

                # A concurrent forced request already refreshed this data.
                if payload is not None and force_generation != starting_generation:
                    return payload

            payload = fetch_balances(force_prices=True)
            with balances_cache_lock:
                balances_cache["payload"] = payload
                balances_cache["time"] = time.monotonic()
                balances_cache["force_generation"] = (
                    int(balances_cache.get("force_generation") or 0) + 1
                )
            return payload

    now = time.monotonic()

    with balances_cache_lock:
        payload = balances_cache.get("payload")
        cached_at = float(balances_cache.get("time") or 0)

        if (
            payload is not None
            and now - cached_at < BALANCES_CACHE_SECONDS
        ):
            return payload

    with balances_refresh_lock:
        now = time.monotonic()

        with balances_cache_lock:
            payload = balances_cache.get("payload")
            cached_at = float(balances_cache.get("time") or 0)

            if (
                payload is not None
                and now - cached_at < BALANCES_CACHE_SECONDS
            ):
                return payload

        payload = fetch_balances(force_prices=False)

        with balances_cache_lock:
            balances_cache["payload"] = payload
            balances_cache["time"] = time.monotonic()

        return payload


@app.get("/api/balances")
async def get_balances(
    generation: Annotated[Optional[int], Query(ge=0)] = None,
    force_prices: Annotated[bool, Query()] = False,
):
    requested_generation = int(generation or 0)
    required_generation = max(requested_generation, balance_generation)
    result = await run_coinbase_singleflight(
        ("balances", bool(force_prices)),
        get_cached_balances,
        force_prices,
        _lane="balances",
    )

    return {
        **result,
        "generation": required_generation,
    }


@app.get("/api/balance-history")
def get_balance_history(
    period: Annotated[str, Query()] = "all",
):
    return {
        "points": filter_balance_history(period),
    }


async def broadcast_app_state(state, change=None):
    message = {
        "type": "app_state",
        "state": state,
        "change": change or {},
    }

    disconnected = []

    for client in list(app_state_clients):
        try:
            await client.send_json(message)
        except Exception:
            disconnected.append(client)

    for client in disconnected:
        app_state_clients.discard(client)


@app.get("/api/app-state")
async def get_app_state():
    async with app_state_lock:
        return app_state_payload()


@app.put("/api/app-state/bookmarks/{currency}")
async def put_app_state_bookmark(
    currency: str,
    body: Annotated[dict, Body()],
):
    price = body.get("price") if isinstance(body, dict) else None

    async with app_state_lock:
        state = set_app_state_bookmark(currency, price)
        if state is None:
            raise HTTPException(status_code=500, detail="Could not persist bookmark.")
        payload = app_state_payload()

    await broadcast_app_state(payload, {
        "type": "bookmark_set",
        "currency": normalize_bookmark_currency(currency),
        "price": payload["yzTrade"]["bookmarks"].get(normalize_bookmark_currency(currency)),
    })

    return payload


@app.delete("/api/app-state/bookmarks/{currency}")
async def remove_app_state_bookmark(currency: str):
    normalized_currency = normalize_bookmark_currency(currency)

    async with app_state_lock:
        state = delete_app_state_bookmark(normalized_currency)
        if state is None:
            raise HTTPException(status_code=500, detail="Could not persist bookmark.")
        payload = app_state_payload()

    await broadcast_app_state(payload, {
        "type": "bookmark_deleted",
        "currency": normalized_currency,
    })

    return payload


@app.put("/api/app-state/settings")
async def put_app_state_settings(body: Annotated[dict, Body()]):
    async with app_state_lock:
        state = set_app_state_settings(body)
        if state is None:
            raise HTTPException(status_code=500, detail="Could not persist settings.")
        payload = app_state_payload()

    await broadcast_app_state(payload, {
        "type": "settings_updated",
        "settings": payload["yzTrade"]["settings"],
    })

    return payload


@app.websocket("/api/app-state/live")
async def live_app_state(websocket: WebSocket):
    await websocket.accept()

    async with app_state_lock:
        state = app_state_payload()

    app_state_clients.add(websocket)
    await websocket.send_json({
        "type": "app_state",
        "state": state,
        "change": {"type": "initial"},
    })

    async def send_heartbeat():
        while True:
            await asyncio.sleep(APP_STATE_HEARTBEAT_SECONDS)
            await websocket.send_json({
                "type": "heartbeat",
            })

    heartbeat_task = asyncio.create_task(send_heartbeat())

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)
        app_state_clients.discard(websocket)


@app.websocket("/api/live")
async def live_market(
    websocket: WebSocket,
    product_id: str = PRODUCT_ID,
    days: int = 5,
    granularity: Optional[int] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
):
    global live_client_count

    await websocket.accept()
    live_client_count += 1

    try:
        import websockets
    except ImportError:
        await websocket.send_json({
            "type": "error",
            "message": "Python package 'websockets' is required. Install requirements.txt.",
        })
        await websocket.close(code=1011)
        live_client_count = max(0, live_client_count - 1)
        return

    product_id = product_id.upper()
    candle_granularity = get_granularity_for_days(days, granularity)
    send_lock = asyncio.Lock()
    register_live_ws_client(websocket, send_lock)

    print(
        "LIVE CLIENT CONNECTED "
        f"product={product_id} "
        f"clients={live_client_count}",
        flush=True,
    )

    async def send_to_client(message):
        async with send_lock:
            await websocket.send_json(message)

    def normalize_level_side(side):
        normalized = str(side or "").lower()

        if normalized in ("bid", "bids", "buy"):
            return "bid"

        if normalized in ("ask", "asks", "offer", "offers", "sell"):
            return "ask"

        return normalized

    def build_depth_message(bids, asks):
        def normalize_levels(levels, reverse=False):
            rows = []

            for price, size in sorted(levels.items(), reverse=reverse):
                if min_price is not None and price < min_price:
                    continue

                if max_price is not None and price > max_price:
                    continue

                rows.append({
                    "price": price,
                    "size": size,
                    "orders": 1,
                })

            return rows

        best_bid = max(bids) if bids else None
        best_ask = min(asks) if asks else None
        current_price = None

        if best_bid is not None and best_ask is not None:
            current_price = (best_bid + best_ask) / 2
        elif best_bid is not None:
            current_price = best_bid
        elif best_ask is not None:
            current_price = best_ask

        return {
            "type": "depth_update",
            "product_id": product_id,
            "depth": {
                "product_id": product_id,
                "current_price": current_price,
                "min_price": min_price,
                "max_price": max_price,
                "bids": normalize_levels(bids, reverse=True),
                "asks": normalize_levels(asks),
            },
        }

    async def send_depth_update(bids, asks):
        depth_message = build_depth_message(bids, asks)
        await send_to_client(depth_message)

    def live_timestamp():
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def log_live(message):
        print(f"LIVE_TRACE ts={live_timestamp()} {message}", flush=True)

    def extract_coinbase_ws_time(data):
        raw = data.get("timestamp") if isinstance(data, dict) else None

        if not raw:
            return None

        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            return None

    async def stream_market_data():
        subscribe_messages = [
            {
                "type": "subscribe",
                "channel": "heartbeats",
            },
            {
                "type": "subscribe",
                "product_ids": [product_id],
                "channel": "market_trades",
            },
            {
                "type": "subscribe",
                "product_ids": [product_id],
                "channel": "ticker",
            },
        ]
        last_heartbeat_send = 0
        last_price_message = time.monotonic()
        coinbase_time = None
        market_subscribed_sent = False

        async def send_price_update(price, size=0, side=None, price_time=None, source="ticker"):
            nonlocal last_price_message

            if price_time is None:
                price_time = datetime.now(timezone.utc)

            bucket_time = int(price_time.timestamp()) // candle_granularity * candle_granularity
            last_price_message = time.monotonic()

            await send_to_client({
                "type": "trade",
                "product_id": product_id,
                "granularity": candle_granularity,
                "time": bucket_time,
                "price": price,
                "size": size,
                "side": side,
                "trade_time": price_time.isoformat(),
                "source": source,
            })

        async with websockets.connect(
            COINBASE_WS_API,
            ssl=get_ssl_context(),
            ping_interval=20,
            ping_timeout=20,
            close_timeout=5,
        ) as coinbase_ws:
            for message in subscribe_messages:
                await coinbase_ws.send(json.dumps(message))

            while True:
                try:
                    # Any Coinbase message (including heartbeats) proves the socket is alive.
                    # Flat price alone must not force unsubscribe/resubscribe.
                    raw_message = await asyncio.wait_for(
                        coinbase_ws.recv(),
                        timeout=COINBASE_LIVE_STALE_SECONDS,
                    )
                except asyncio.TimeoutError:
                    age = time.monotonic() - last_price_message
                    log_live(
                        "MARKET_SILENT "
                        f"product={product_id} "
                        f"last_price_age={age:.1f}s "
                        f"limit={COINBASE_LIVE_STALE_SECONDS}s "
                        "action=reconnect"
                    )
                    raise RuntimeError(
                        f"MARKET_SILENT product={product_id} "
                        f"limit={COINBASE_LIVE_STALE_SECONDS}s"
                    )

                data = json.loads(raw_message)

                if data.get("channel") == "heartbeats":
                    hb_time = extract_coinbase_ws_time(data)
                    if hb_time is not None:
                        coinbase_time = hb_time

                    if not market_subscribed_sent and coinbase_time is not None:
                        await send_to_client({
                            "type": "subscribed",
                            "stream": "market",
                            "product_id": product_id,
                            "granularity": candle_granularity,
                            "coinbase_time": coinbase_time.isoformat(),
                        })
                        market_subscribed_sent = True
                        log_live(
                            f"PRICE_CONNECTED product={product_id} "
                            f"channels=market_trades,ticker "
                            f"coinbase_time={coinbase_time.isoformat()}"
                        )

                    now = time.monotonic()

                    if now - last_heartbeat_send >= 10:
                        heartbeat_message = {
                            "type": "heartbeat",
                            "stream": "market",
                            "product_id": product_id,
                        }
                        if coinbase_time is not None:
                            heartbeat_message["coinbase_time"] = coinbase_time.isoformat()
                        await send_to_client(heartbeat_message)
                        last_heartbeat_send = now
                elif data.get("channel") == "market_trades":
                    for event in data.get("events", []):
                        for trade in event.get("trades", []):
                            if str(trade.get("product_id", "")).upper() != product_id:
                                continue

                            try:
                                price = float(trade["price"])
                                size = float(trade.get("size") or 0)
                                traded_at = datetime.fromisoformat(
                                    str(trade.get("time")).replace("Z", "+00:00")
                                )
                            except (TypeError, ValueError, KeyError):
                                continue

                            await send_price_update(
                                price,
                                size=size,
                                side=trade.get("side"),
                                price_time=traded_at,
                                source="market_trades",
                            )
                elif data.get("channel") in ("ticker", "ticker_batch"):
                    for event in data.get("events", []):
                        tickers = event.get("tickers", [])

                        for ticker in tickers:
                            if str(ticker.get("product_id", "")).upper() != product_id:
                                continue

                            try:
                                price = float(ticker["price"])
                            except (TypeError, ValueError, KeyError):
                                continue

                            ticker_time = None
                            raw_time = ticker.get("time") or event.get("time") or data.get("timestamp")

                            if raw_time:
                                try:
                                    ticker_time = datetime.fromisoformat(str(raw_time).replace("Z", "+00:00"))
                                except ValueError:
                                    ticker_time = None

                            await send_price_update(
                                price,
                                price_time=ticker_time,
                                source=str(data.get("channel")),
                            )

    async def stream_depth_data():
        subscribe_messages = [
            {
                "type": "subscribe",
                "channel": "heartbeats",
            },
            {
                "type": "subscribe",
                "product_ids": [product_id],
                "channel": "level2",
            },
        ]
        bids = {}
        asks = {}
        last_depth_send = 0
        last_heartbeat_send = 0

        async with websockets.connect(
            COINBASE_WS_API,
            ssl=get_ssl_context(),
            ping_interval=20,
            ping_timeout=20,
            close_timeout=5,
            max_size=COINBASE_DEPTH_WS_MAX_SIZE,
        ) as coinbase_ws:
            for message in subscribe_messages:
                await coinbase_ws.send(json.dumps(message))

            await send_to_client({
                "type": "subscribed",
                "stream": "depth",
                "product_id": product_id,
            })
            print(f"COINBASE LIVE DEPTH OK product={product_id}", flush=True)

            while True:
                try:
                    raw_message = await asyncio.wait_for(
                        coinbase_ws.recv(),
                        timeout=COINBASE_LIVE_STALE_SECONDS,
                    )
                except asyncio.TimeoutError:
                    log_live(
                        "DEPTH_STALLED "
                        f"product={product_id} "
                        f"limit={COINBASE_LIVE_STALE_SECONDS}s "
                        "action=reconnect"
                    )
                    await send_to_client({
                        "type": "error",
                        "stream": "depth",
                        "product_id": product_id,
                        "timestamp": live_timestamp(),
                        "message": (
                            f"DEPTH_STALLED product={product_id} "
                            f"limit={COINBASE_LIVE_STALE_SECONDS}s action=reconnect"
                        ),
                    })
                    raise RuntimeError(
                        f"DEPTH_STALLED product={product_id} "
                        f"limit={COINBASE_LIVE_STALE_SECONDS}s"
                    )

                data = json.loads(raw_message)

                if data.get("channel") == "heartbeats":
                    now = time.monotonic()

                    if now - last_heartbeat_send >= 10:
                        await send_to_client({
                            "type": "heartbeat",
                            "stream": "depth",
                            "product_id": product_id,
                        })
                        last_heartbeat_send = now
                    continue

                if data.get("channel") not in ("level2", "l2_data"):
                    continue

                should_send_depth = False
                last_event_type = ""

                for event in data.get("events", []):
                    event_type = str(event.get("type", "")).lower()
                    event_product_id = str(event.get("product_id", product_id)).upper()
                    last_event_type = event_type
                    updates = event.get("updates", [])

                    if event_product_id != product_id:
                        continue

                    if event_type == "snapshot":
                        bids.clear()
                        asks.clear()

                    for update in updates:
                        update_product_id = str(update.get("product_id", event_product_id)).upper()

                        if update_product_id != product_id:
                            continue

                        try:
                            price = float(update["price_level"])
                            quantity = float(update["new_quantity"])
                        except (TypeError, ValueError, KeyError):
                            continue

                        side = normalize_level_side(update.get("side"))
                        book_side = bids if side == "bid" else asks if side == "ask" else None

                        if book_side is None:
                            continue

                        if quantity <= 0:
                            book_side.pop(price, None)
                        else:
                            book_side[price] = quantity

                        should_send_depth = True

                    if event_type == "snapshot":
                        should_send_depth = True

                now = time.monotonic()

                if should_send_depth and (last_event_type == "snapshot" or now - last_depth_send >= 0.25):
                    await send_depth_update(bids, asks)
                    last_depth_send = now

    async def stream_user_orders():
        try:
            heartbeat_message = {
                "type": "subscribe",
                "channel": "heartbeats",
                "jwt": build_coinbase_ws_jwt(),
            }
            user_message = {
                "type": "subscribe",
                "channel": "user",
                "jwt": build_coinbase_ws_jwt(),
            }
        except HTTPException as exc:
            await send_to_client({
                "type": "order_stream_error",
                "product_id": product_id,
                "message": exc.detail,
            })
            return

        async with websockets.connect(
            COINBASE_USER_WS_API,
            ssl=get_ssl_context(),
            ping_interval=20,
            ping_timeout=20,
            close_timeout=5,
        ) as coinbase_ws:
            await coinbase_ws.send(json.dumps(heartbeat_message))
            await coinbase_ws.send(json.dumps(user_message))
            await send_to_client({
                "type": "subscribed",
                "stream": "orders",
                "product_id": product_id,
            })
            print(f"COINBASE LIVE ORDERS OK product={product_id}", flush=True)

            async for raw_message in coinbase_ws:
                data = json.loads(raw_message)

                if data.get("channel") != "user":
                    continue

                has_order_event = False
                balance_refresh_mode = None
                order_event_states = []

                for event in data.get("events", []):
                    for order in event.get("orders", []):
                        has_order_event = True
                        order_id = order.get("order_id")
                        status = order.get("status")
                        normalized_status = str(status or "").upper()
                        order_refresh_mode = get_balance_refresh_mode_for_order_status(
                            normalized_status
                        )

                        if order_refresh_mode == "immediate":
                            balance_refresh_mode = "immediate"
                        elif order_refresh_mode == "debounced" and balance_refresh_mode is None:
                            balance_refresh_mode = "debounced"

                        order_event_states.append({
                            "order_id": order_id,
                            "product_id": order.get("product_id"),
                            "status": status,
                            "filled_size": order.get("filled_size") or order.get("cumulative_quantity"),
                            "leaves_quantity": order.get("leaves_quantity"),
                            "completion_percentage": order.get("completion_percentage"),
                            "order_configuration": order.get("order_configuration"),
                        })

                        if is_open_order_status(status):
                            normalized = normalize_order(order)
                            if normalized is not None:
                                orders_list_upsert_from_coinbase(
                                    normalized,
                                    raw_order=order,
                                )
                        elif order_id:
                            dropped = orders_list_apply_closed(order_id)
                            if dropped or not is_open_order_status(status):
                                clear_orders_cache()

                if has_order_event:
                    event_payload = json.dumps(
                        sorted(
                            order_event_states,
                            key=lambda state: (
                                str(state.get("order_id") or ""),
                                str(state.get("status") or ""),
                            ),
                        ),
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    event_id = hashlib.sha256(event_payload.encode("utf-8")).hexdigest()
                    event_generation = (
                        register_balance_order_event(event_id)
                        if balance_refresh_mode is not None
                        else balance_generation
                    )
                    all_orders = list_tracked_orders(product_id, all_products=True)
                    await send_to_client({
                        "type": "orders_update",
                        "event_id": event_id,
                        "snapshot": True,
                        "balance_generation": event_generation,
                        "refresh_balances": balance_refresh_mode is not None,
                        "balance_refresh_mode": balance_refresh_mode,
                        "product_id": product_id,
                        "all_orders": all_orders,
                    })

    async def guarded_stream(name, stream):
        retry_delays = (1, 2, 5, 10)
        retry_index = 0

        while True:
            try:
                if retry_index:
                    log_live(f"RECONNECTING stream={name} product={product_id}")

                await stream()
                await send_to_client({
                    "type": "stream_closed",
                    "stream": name,
                    "product_id": product_id,
                })
                print(
                    "COINBASE LIVE STREAM CLOSED "
                    f"stream={name} "
                    f"product={product_id}",
                    flush=True,
                )
                retry_index = 0
            except WebSocketDisconnect:
                raise
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                delay = retry_delays[min(retry_index, len(retry_delays) - 1)]
                retry_index += 1
                log_live(
                    "STREAM_ERROR "
                    f"stream={name} "
                    f"product={product_id} "
                    f"error={exc} "
                    f"reconnect_in={delay}s"
                )
                await send_to_client({
                    "type": "order_stream_error" if name == "orders" else "error",
                    "stream": name,
                    "product_id": product_id,
                    "timestamp": live_timestamp(),
                    "message": f"Live Coinbase {name} stream failed: {exc}. Reconnecting in {delay}s.",
                    "reconnect_in": delay,
                })
                await asyncio.sleep(delay)

    market_task = asyncio.create_task(guarded_stream("market", stream_market_data))
    depth_task = asyncio.create_task(guarded_stream("depth", stream_depth_data))
    orders_task = asyncio.create_task(guarded_stream("orders", stream_user_orders))

    async def client_keepalive():
        while True:
            await asyncio.sleep(10)

            try:
                await send_to_client({
                    "type": "heartbeat",
                    "stream": "connection",
                    "product_id": product_id,
                })
            except Exception:
                break

    keepalive_task = asyncio.create_task(client_keepalive())

    try:
        await asyncio.gather(market_task, depth_task, orders_task)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        unregister_live_ws_client(websocket, send_lock)
        keepalive_task.cancel()
        market_task.cancel()
        depth_task.cancel()
        orders_task.cancel()
        await asyncio.gather(
            keepalive_task,
            market_task,
            depth_task,
            orders_task,
            return_exceptions=True,
        )
        live_client_count = max(0, live_client_count - 1)
        print(
            "LIVE CLIENT DISCONNECTED "
            f"product={product_id} "
            f"clients={live_client_count}",
            flush=True,
        )


@app.get("/")
@app.get("/{path:path}")
@app.get("/trade")
@app.get("/trade/{path:path}")
async def get_frontend(path: str = ""):
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API endpoint not found.")

    if not os.path.exists(INDEX_HTML):
        raise HTTPException(status_code=404, detail="Frontend build not found. Run the Vite build first.")

    return FileResponse(INDEX_HTML)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=APP_HOST,
        port=APP_PORT,
        reload=APP_RELOAD,
        reload_excludes=["*/data/*", "data/*"],
    )
