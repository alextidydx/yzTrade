import axios from "axios";

import { API_BASE } from "./utils/homeConstants";

const get = (path, params) => axios.get(`${API_BASE}${path}`, { params });
const post = (path, data, config) => axios.post(`${API_BASE}${path}`, data, config);
const put = (path, data, config) => axios.put(`${API_BASE}${path}`, data, config);
const del = (path, config) => axios.delete(`${API_BASE}${path}`, config);

export const getAppState = () => get("/api/app-state", { _: Date.now() });

export const getCandles = (params) => get("/api/candles", params);

export const getDepth = (params) => get("/api/depth", params);

export const getProduct = (productId) => get("/api/product", {
	product_id: productId,
	_: Date.now(),
});

export const getTdSequential = (params) => get("/api/td-sequential", params);

export const getMonitorTickers = () => get("/api/monitor-tickers", { _: Date.now() });

export const getBalances = () => get("/api/balances", { _: Date.now() });

export const getOrders = (params) => get("/api/orders", params);

export const setBookmark = (currency, price) => (
	put(`/api/app-state/bookmarks/${encodeURIComponent(currency)}`, { price })
);

export const deleteBookmark = (currency) => (
	del(`/api/app-state/bookmarks/${encodeURIComponent(currency)}`)
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
