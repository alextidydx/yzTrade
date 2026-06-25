import axios from "axios";

import { API_BASE } from "./utils/homeConstants";

const API_TIMEOUT_MS = 15000;
const GET_RETRY_DELAY_MS = 500;

const http = axios.create({
	timeout: API_TIMEOUT_MS,
});

const delay = (ms) => new Promise(resolve => {
	globalThis.setTimeout(resolve, ms);
});

const shouldRetryGet = (error) => (
	error?.code === "ECONNABORTED"
	|| error?.code === "ERR_NETWORK"
	|| !error?.response
);

const get = (path, params) => (
	http.get(`${API_BASE}${path}`, { params }).catch(error => {
		if (!shouldRetryGet(error)) throw error;

		return delay(GET_RETRY_DELAY_MS).then(() => (
			http.get(`${API_BASE}${path}`, { params })
		));
	})
);
const post = (path, data, config) => http.post(`${API_BASE}${path}`, data, config);
const put = (path, data, config) => http.put(`${API_BASE}${path}`, data, config);
const del = (path, config) => http.delete(`${API_BASE}${path}`, config);

export const getAppState = () => get("/api/app-state", { _: Date.now() });

export const getCandles = (params) => get("/api/candles", params);

export const getDepth = (params) => get("/api/depth", params);

export const getProduct = (productId) => get("/api/product", {
	product_id: productId,
	_: Date.now(),
});

export const getProductStats = (productId) => get("/api/product-stats", {
	product_id: productId,
	_: Date.now(),
});

export const getTdSequential = (params) => get("/api/td-sequential", params);

export const getMonitorTickers = () => get("/api/monitor-tickers", { _: Date.now() });

export const getBalances = () => get("/api/balances", { _: Date.now() });

export const getBalanceHistory = (params) => get("/api/balance-history", params);

export const getOrders = (params) => get("/api/orders", params);

export const setBookmark = (currency, price) => (
	put(`/api/app-state/bookmarks/${encodeURIComponent(currency)}`, { price })
);

export const deleteBookmark = (currency) => (
	del(`/api/app-state/bookmarks/${encodeURIComponent(currency)}`)
);

export const updateAppSettings = (settings) => (
	put("/api/app-state/settings", settings)
);

export const previewOrder = (body) => post("/api/orders/preview", body);

export const placeOrder = (body) => post("/api/orders/place", body);

export const cancelOrder = (orderId) => (
	post("/api/orders/cancel", null, {
		params: {
			order_id: orderId,
		},
	})
);
