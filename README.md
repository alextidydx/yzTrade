![yzTrade chart](docs/yztrade.jpg)

# yzTrade

Coinbase trading and market-visualization app.

It has two parts:

- **Backend API**: FastAPI app in `app.py` for Coinbase candles, depth, balances, orders, live websocket streams, and order placement.
- **Frontend**: Vite/React app in `client/` using `lightweight-charts` for candles, volume, VWAP, TD Sequential, orders, price bookmarks, distribution, and vertical depth.

The UI lets you type a base currency like `GFI`, `BTC`, or `ETH`; the app loads Coinbase products quoted against USD/USDC where needed.

## Features

- Coinbase candles with selectable periods, including Active mode.
- Live price, depth, balances, and orders.
- Vertical depth curve from the latest/current price.
- Open order lines with cancel controls.
- Balance and orders menus with currency navigation.
- Price overlay with live price, 24h change, and 24h volume.
- VWAP, TD Sequential, histogram toggles, price bookmark, auto/log/inverted scale controls.
- Order ticket for buy/sell limit, market, stop-limit, and sell bracket orders.
- Orders are previewed through Coinbase before placement, showing total, fee, and received amount before the final Place action.

## Install

Backend:

```powershell
python -m pip install -r requirements.txt
```

Frontend:

```powershell
cd client
npm install
```

## Environment

Copy the template and fill in your own credentials:

```powershell
Copy-Item .env_default .env
```

The template looks like this:

```env
APP_HOST=0.0.0.0
APP_PORT=5003
APP_RELOAD=true
MONITOR_TICKERS=BTC,ETH,ICP,PENGU,XLM,ADA,CRV,ALGO,PENDLE,GFI,NMR,FET,AAVE,XRP,SUI,DOGE,PEPE,FIL,TAO,SOL,ZEC,LTC,SEI,BONK

COINBASE_API_KEY=organizations/<<YOUR_ORG_ID>>/apiKeys/<<YOUR_API_KEY_ID>>
COINBASE_API_SECRET="-----BEGIN EC PRIVATE KEY-----\n<<YOUR_PRIVATE_KEY>>\n-----END EC PRIVATE KEY-----"
```

You need to create your own Coinbase Advanced Trade API key and private key in Coinbase, then paste those values into `.env`. The app uses those credentials for authenticated balances, orders, order placement, and the user order websocket.

`.env` is local and should not be committed. `.env_default` is safe to commit because it contains placeholders only.

## Run

Build the frontend:

```powershell
cd client
npm run build
```

Run the backend API and built frontend using `.env` host/port:

```powershell
cd ..
python app.py
```

Open:

```text
http://127.0.0.1:5003/
```

For VPN/LAN access, use the machine IP:

```text
http://<machine-ip>:5003/
```

## Development

Start the backend:

```powershell
python app.py
```

Start Vite:

```powershell
cd client
npm run dev
```

Vite runs on:

```text
http://127.0.0.1:5173/
```

The Vite dev server proxies `/api` requests to `http://127.0.0.1:5003`.

## Tests

The current test coverage focuses on the money-risk order payloads:

- BUY limit uses quote size, not base size.
- SELL limit uses base size, not quote size.
- Market orders do not send price fields.
- Stop-limit and bracket order fields map to Coinbase correctly.

Run backend tests:

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'
python -m pytest tests -q
```

The `PYTEST_DISABLE_PLUGIN_AUTOLOAD` line avoids unrelated globally installed pytest plugins from interfering with this project.

## Disclaimer

This project is provided for educational and informational purposes only. It is not financial advice, investment advice, or a recommendation to buy, sell, or trade any asset.

Trading cryptocurrencies involves risk, including possible loss of funds. Use this software at your own risk. The author is not responsible for any financial losses, API misuse, order execution errors, exchange issues, bugs, downtime, or other damages resulting from use of this project.

Review all orders carefully before placing them and test with small amounts first.

## Security And Production Use

Never commit your real API keys, private keys, secrets, or trading credentials to this repository. Keep credentials in your local `.env` file only, and use `.env_default` as a template.

If you use live Coinbase credentials, this app may be able to place or cancel real orders depending on your API key permissions. Review Coinbase API permissions carefully, use the minimum permissions needed, and test with small amounts before using larger balances.

This project is not hardened for production deployment. If you expose it on a network or VPN, secure access yourself and understand the risks before using it with funded accounts.
