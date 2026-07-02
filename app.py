from datetime import datetime, timedelta, timezone
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal, ROUND_DOWN, InvalidOperation
import os
import secrets
import shutil
import ssl
import subprocess
import tempfile
import time
from typing import Annotated, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json
import math

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
GRANULARITY_SECONDS = 3600
CANDLE_REQUEST_LIMIT = 300
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "public")
INDEX_HTML = os.path.join(PUBLIC_DIR, "index.html")
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
APP_STATE_FILE = os.getenv("APP_STATE_FILE", os.path.join(DATA_DIR, "app_state.json"))
BALANCE_HISTORY_FILE = os.getenv("BALANCE_HISTORY_FILE", os.path.join(DATA_DIR, "balance_history.json"))
BALANCE_HISTORY_BUCKET_SECONDS = 60 * 60
BALANCE_HISTORY_RETENTION_SECONDS = 5 * 365 * 24 * 60 * 60
DEFAULT_APP_STATE = {
    "version": 1,
    "yzTrade": {
        "bookmarks": {},
        "settings": {
            "balanceHistoryExpanded": False,
        },
    },
}
USD_PEGGED_CURRENCIES = {"USD", "USDC", "USDT", "DAI", "PYUSD"}
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
    normalized["yzTrade"]["settings"] = {
        **DEFAULT_APP_STATE["yzTrade"]["settings"],
        **settings,
    }
    normalized["yzTrade"]["settings"]["balanceHistoryExpanded"] = bool(
        normalized["yzTrade"]["settings"].get("balanceHistoryExpanded")
    )

    return normalized


def read_app_state():
    if not os.path.exists(APP_STATE_FILE):
        return get_default_app_state()

    try:
        with open(APP_STATE_FILE, "r", encoding="utf-8") as state_file:
            return normalize_app_state(json.load(state_file))
    except (OSError, json.JSONDecodeError):
        return get_default_app_state()


def write_app_state(state):
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

    state = read_app_state()
    state.setdefault("yzTrade", {}).setdefault("bookmarks", {})[normalized_currency] = numeric_price

    return write_app_state(state)


def delete_app_state_bookmark(currency):
    normalized_currency = normalize_bookmark_currency(currency)
    state = read_app_state()
    state.setdefault("yzTrade", {}).setdefault("bookmarks", {}).pop(normalized_currency, None)

    return write_app_state(state)


def set_app_state_settings(settings):
    if not isinstance(settings, dict):
        raise HTTPException(status_code=400, detail="Invalid app settings.")

    state = read_app_state()
    yztrade = state.setdefault("yzTrade", {})
    current_settings = yztrade.setdefault("settings", {})

    if "balanceHistoryExpanded" in settings:
        current_settings["balanceHistoryExpanded"] = bool(settings.get("balanceHistoryExpanded"))

    return write_app_state(state)


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


def read_balance_history():
    if not os.path.exists(BALANCE_HISTORY_FILE):
        return []

    try:
        with open(BALANCE_HISTORY_FILE, "r", encoding="utf-8") as history_file:
            return normalize_balance_history(json.load(history_file))
    except (OSError, json.JSONDecodeError):
        return []


def write_balance_history(history):
    normalized = normalize_balance_history(history)
    history_dir = os.path.dirname(BALANCE_HISTORY_FILE)

    if history_dir:
        os.makedirs(history_dir, exist_ok=True)

    fd, temp_path = tempfile.mkstemp(
        prefix=".balance_history.",
        suffix=".json",
        dir=history_dir or None,
        text=True,
    )

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as temp_file:
            json.dump(normalized, temp_file, indent=2, sort_keys=True)
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

app = FastAPI()
live_client_count = 0
app_state_clients = set()
app_state_lock = asyncio.Lock()
APP_STATE_HEARTBEAT_SECONDS = 10
COINBASE_LIVE_STALE_SECONDS = 25
COINBASE_DEPTH_WS_MAX_SIZE = 16 * 1024 * 1024

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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


def coinbase_get(path, params=None):
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
        with urlopen(request, timeout=15, context=context) as response:
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


def build_coinbase_jwt_from_payload(payload):
    api_key = os.getenv("COINBASE_API_KEY")
    api_secret = os.getenv("COINBASE_API_SECRET", "").replace("\\n", "\n")

    if not api_key or not api_secret:
        raise HTTPException(
            status_code=500,
            detail="Coinbase API credentials are missing. Set COINBASE_API_KEY and COINBASE_API_SECRET.",
        )

    openssl_path = shutil.which("openssl")

    if not openssl_path:
        raise HTTPException(
            status_code=500,
            detail="Coinbase order auth requires OpenSSL to sign JWTs for this local app.",
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

    key_path = None

    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as key_file:
            key_file.write(api_secret)
            key_path = key_file.name

        result = subprocess.run(
            [openssl_path, "dgst", "-sha256", "-sign", key_path],
            input=signing_input.encode("utf-8"),
            capture_output=True,
            check=True,
            timeout=5,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        detail = getattr(exc, "stderr", b"") or str(exc)
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", errors="replace")
        raise HTTPException(status_code=500, detail=f"Unable to sign Coinbase JWT: {detail}") from exc
    finally:
        if key_path and os.path.exists(key_path):
            os.remove(key_path)

    return f"{signing_input}.{der_to_jose(result.stdout)}"


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


def get_usd_price_for_currency(currency):
    normalized_currency = str(currency or "").upper()

    if normalized_currency in USD_PEGGED_CURRENCIES:
        return 1.0

    try:
        ticker = coinbase_get(f"/products/{normalized_currency}-USD/ticker")
    except HTTPException:
        return None

    price = parse_float(ticker.get("price"))

    return price if price is not None and price > 0 else None


def parse_order_price(value):
    price = parse_float(value)

    return price if price is not None and price > 0 else None


def positive_float(value):
    parsed = parse_float(value)

    return parsed if parsed is not None and parsed > 0 else None


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
        body["client_order_id"] = secrets.token_hex(16)

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
        take_profit_price = parse_order_price(bracket_config.get("limit_price"))
        stop_loss_price = parse_order_price(bracket_config.get("stop_trigger_price"))

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
        "leaves_quantity": positive_float(order.get("leaves_quantity")),
        "quote_size": quote_size,
        "order_type": order_type,
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


def aggregate_candles(candles, bucket_seconds):
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
            "time": bucket["time"] + bucket_seconds,
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

    closed_markers = (
        "CANCEL",
        "FILLED",
        "EXPIRED",
        "FAILED",
        "REJECTED",
    )

    return not any(marker in normalized for marker in closed_markers)


@app.get("/api/candles")
def get_candles(
    product_id: Annotated[str, Query()] = PRODUCT_ID,
    days: Annotated[int, Query(ge=1, le=28)] = 7,
    granularity: Annotated[Optional[int], Query()] = None,
    end_time: Annotated[Optional[int], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=CANDLE_REQUEST_LIMIT)] = CANDLE_REQUEST_LIMIT,
):
    candle_granularity = get_granularity_for_days(days, granularity)

    if end_time is not None:
        end = datetime.fromtimestamp(end_time, timezone.utc)
        start = end - timedelta(seconds=candle_granularity * limit)
    else:
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days)

    rows = fetch_coinbase_candles(product_id, start, end, candle_granularity)
    return normalize_candle_rows(rows)


@app.get("/api/product")
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


@app.get("/api/monitor-config")
def get_monitor_config():
    return {
        "tickers": MONITOR_TICKERS,
        "default_base_currency": MONITOR_TICKERS[0] if MONITOR_TICKERS else "BTC",
    }


@app.get("/api/monitor-tickers")
def get_monitor_tickers():
    with ThreadPoolExecutor(max_workers=8) as executor:
        tickers = list(executor.map(fetch_monitor_ticker, MONITOR_TICKERS))

    return {
        "quote_currency": "USD",
        "refresh_seconds": 60,
        "tickers": tickers,
    }


@app.get("/api/depth")
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


@app.get("/api/orders")
def get_orders(
    product_id: Annotated[str, Query()] = PRODUCT_ID,
    all_products: Annotated[bool, Query()] = False,
):
    normalized_product_id = product_id.upper()
    selected_base_currency = get_base_currency(normalized_product_id)

    try:
        data = coinbase_advanced_get(
            "/api/v3/brokerage/orders/historical/batch",
            {
                "order_status": ["OPEN"],
            },
        )
    except HTTPException as exc:
        print(
            f"COINBASE CONNECT FAILED product={normalized_product_id} status={exc.status_code} detail={exc.detail}",
            flush=True,
        )
        return {
            "product_id": normalized_product_id,
            "open_total": 0,
            "exact_total": 0,
            "applicable_total": 0,
            "drawable_total": 0,
            "skipped_total": 0,
            "orders": [],
            "error": exc.detail,
        }

    raw_orders = data.get("orders", [])
    if all_products:
        exact_product_orders = []
        base_product_orders = []
        product_orders = raw_orders
    else:
        exact_product_orders = [
            order
            for order in raw_orders
            if str(order.get("product_id", "")).upper() == normalized_product_id
        ]
        base_product_orders = [
            order
            for order in raw_orders
            if order_applies_to_product(order, normalized_product_id)
        ]
        product_orders = exact_product_orders or base_product_orders
    orders = []
    skipped = 0

    for order in product_orders:
        normalized = normalize_order(order)

        if normalized is None:
            skipped += 1
            continue

        orders.append(normalized)

    print(
        "COINBASE CONNECT OK "
        f"product={normalized_product_id} "
        f"base={selected_base_currency} "
        f"all_products={all_products} "
        f"open_total={len(raw_orders)} "
        f"exact={len(exact_product_orders)} "
        f"applicable={len(product_orders)} "
        f"drawable={len(orders)} "
        f"skipped={skipped}",
        flush=True,
    )

    return {
        "product_id": normalized_product_id,
        "open_total": len(raw_orders),
        "exact_total": len(exact_product_orders),
        "applicable_total": len(product_orders),
        "drawable_total": len(orders),
        "skipped_total": skipped,
        "orders": orders,
    }


@app.post("/api/orders/cancel")
def cancel_order(
    order_id: Annotated[str, Query()],
):
    if not order_id:
        raise HTTPException(status_code=400, detail="order_id is required.")

    try:
        data = coinbase_advanced_post(
            "/api/v3/brokerage/orders/batch_cancel",
            {
                "order_ids": [order_id],
            },
        )
    except HTTPException as exc:
        print(
            f"COINBASE CANCEL FAILED order_id={order_id} status={exc.status_code} detail={exc.detail}",
            flush=True,
        )
        raise

    results = data.get("results", [])
    result = results[0] if results else {}
    success = bool(result.get("success"))

    print(
        f"COINBASE CANCEL {'OK' if success else 'FAILED'} "
        f"order_id={order_id} "
        f"failure_reason={result.get('failure_reason') or ''}",
        flush=True,
    )

    if not success:
        raise HTTPException(
            status_code=400,
            detail=result.get("failure_reason") or result.get("error_response") or "Coinbase did not cancel the order.",
        )

    return {
        "order_id": order_id,
        "success": success,
        "result": result,
    }


@app.post("/api/orders/place")
def place_order(order: dict):
    order_request = build_coinbase_order_request(order, include_client_order_id=True)
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
        normalized_order = apply_preview_snapshot_to_order({
            "id": order_id,
            "product_id": product_id,
            "side": side.lower(),
            "price": parse_order_price(order.get("limit_price") or order.get("stop_price")),
            "filled_percent": 0,
            "bracket_legs": [],
            "status": "OPEN",
        }, order)

    if normalized_order is not None:
        response = {
            **response,
            "order": normalized_order,
        }

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
def preview_order(order: dict):
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


@app.get("/api/balances")
def get_balances():
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

        usd_price = get_usd_price_for_currency(currency)
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
        f"total_usd={total_usd:.2f}",
        flush=True,
    )

    record_balance_history_point(total_usd)

    return {
        "total_usd": total_usd,
        "priced_total": priced_total,
        "unpriced_total": unpriced_total,
        "balances": balances,
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
        return read_app_state()


@app.put("/api/app-state/bookmarks/{currency}")
async def put_app_state_bookmark(
    currency: str,
    body: Annotated[dict, Body()],
):
    price = body.get("price") if isinstance(body, dict) else None

    async with app_state_lock:
        state = set_app_state_bookmark(currency, price)

    await broadcast_app_state(state, {
        "type": "bookmark_set",
        "currency": normalize_bookmark_currency(currency),
        "price": state["yzTrade"]["bookmarks"].get(normalize_bookmark_currency(currency)),
    })

    return state


@app.delete("/api/app-state/bookmarks/{currency}")
async def remove_app_state_bookmark(currency: str):
    normalized_currency = normalize_bookmark_currency(currency)

    async with app_state_lock:
        state = delete_app_state_bookmark(normalized_currency)

    await broadcast_app_state(state, {
        "type": "bookmark_deleted",
        "currency": normalized_currency,
    })

    return state


@app.put("/api/app-state/settings")
async def put_app_state_settings(body: Annotated[dict, Body()]):
    async with app_state_lock:
        state = set_app_state_settings(body)

    await broadcast_app_state(state, {
        "type": "settings_updated",
        "settings": state["yzTrade"]["settings"],
    })

    return state


@app.websocket("/api/app-state/live")
async def live_app_state(websocket: WebSocket):
    await websocket.accept()

    async with app_state_lock:
        state = read_app_state()

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
    days: int = 7,
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

            await send_to_client({
                "type": "subscribed",
                "stream": "market",
                "product_id": product_id,
                "granularity": candle_granularity,
            })
            log_live(f"PRICE_CONNECTED product={product_id} channels=market_trades,ticker")

            while True:
                try:
                    raw_message = await asyncio.wait_for(
                        coinbase_ws.recv(),
                        timeout=COINBASE_LIVE_STALE_SECONDS,
                    )
                except asyncio.TimeoutError:
                    age = time.monotonic() - last_price_message
                    log_live(
                        "PRICE_STALLED "
                        f"product={product_id} "
                        f"age={age:.1f}s "
                        f"limit={COINBASE_LIVE_STALE_SECONDS}s "
                        "action=reconnect"
                    )
                    await send_to_client({
                        "type": "error",
                        "stream": "market",
                        "product_id": product_id,
                        "timestamp": live_timestamp(),
                        "message": (
                            f"PRICE_STALLED product={product_id} "
                            f"age={age:.1f}s limit={COINBASE_LIVE_STALE_SECONDS}s action=reconnect"
                        ),
                    })
                    raise RuntimeError(
                        f"PRICE_STALLED product={product_id} "
                        f"age={age:.1f}s limit={COINBASE_LIVE_STALE_SECONDS}s"
                    )

                data = json.loads(raw_message)
                price_age = time.monotonic() - last_price_message

                if price_age > COINBASE_LIVE_STALE_SECONDS:
                    log_live(
                        "PRICE_STALLED "
                        f"product={product_id} "
                        f"age={price_age:.1f}s "
                        f"limit={COINBASE_LIVE_STALE_SECONDS}s "
                        "action=reconnect"
                    )
                    await send_to_client({
                        "type": "error",
                        "stream": "market",
                        "product_id": product_id,
                        "timestamp": live_timestamp(),
                        "message": (
                            f"PRICE_STALLED product={product_id} "
                            f"age={price_age:.1f}s limit={COINBASE_LIVE_STALE_SECONDS}s action=reconnect"
                        ),
                    })
                    raise RuntimeError(
                        f"PRICE_STALLED product={product_id} "
                        f"age={price_age:.1f}s limit={COINBASE_LIVE_STALE_SECONDS}s"
                    )

                if data.get("channel") == "heartbeats":
                    now = time.monotonic()

                    if now - last_heartbeat_send >= 10:
                        await send_to_client({
                            "type": "heartbeat",
                            "stream": "market",
                            "product_id": product_id,
                        })
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

                updated_orders = []
                removed_order_ids = []

                for event in data.get("events", []):
                    for order in event.get("orders", []):
                        if not order_applies_to_product(order, product_id):
                            continue

                        order_id = order.get("order_id")
                        status = order.get("status")
                        normalized = normalize_order(order)

                        if is_open_order_status(status):
                            if normalized is not None:
                                updated_orders.append(normalized)
                        elif order_id:
                            removed_order_ids.append(order_id)

                if updated_orders or removed_order_ids:
                    await send_to_client({
                        "type": "orders_update",
                        "product_id": product_id,
                        "orders": updated_orders,
                        "removed_order_ids": removed_order_ids,
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
def get_frontend(path: str = ""):
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
    )
