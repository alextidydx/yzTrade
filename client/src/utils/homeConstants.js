export const API_BASE = import.meta.env.VITE_API_BASE
	|| (typeof window !== "undefined" && window.location.pathname.startsWith("/trade") ? "/trade" : "");

export const DISTRIBUTION_BINS = 160;
export const DEPTH_RANGE_PADDING = 1.2;
export const DEPTH_CHART_PADDING_RATIO = 0.13;
export const MIN_DEPTH_WIDTH_RATIO = 0.1;
export const DEFAULT_PERIOD_DAYS = 5;
export const MAX_VISIBLE_PERIOD_DAYS = 20;
export const DEFAULT_DEPTH_CHART_WIDTH_RATIO = 0.15;
export const PRICE_PRECISION = 6;
export const PRICE_MIN_MOVE = 0.000001;
export const CHART_TIME_ZONE = import.meta.env.TIME_ZONE || "America/New_York";
export const TD_TIMEFRAME_SECONDS = 4 * 60 * 60;
export const TD_REFRESH_RETRY_DELAYS = [0, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
export const DROPDOWN_TRANSITION_MS = 160;
export const ORDER_TICKET_FALLBACK_HEIGHT = 430;
export const ORDER_TICKET_ANCHOR_OFFSET_Y = ORDER_TICKET_FALLBACK_HEIGHT / 2;
export const ORDER_TICKET_RIGHT_OFFSET = 113;
export const MARKET_PREVIEW_POLL_INTERVAL_MS = 3000;
export const ORDER_FRACTIONS = [
	{ label: "1/4", value: 0.25 },
	{ label: "1/3", value: 1 / 3 },
	{ label: "1/2", value: 0.5 },
	{ label: "MAX", value: 1 },
];
export const PEAK_THRESHOLD = 0.35;
export const INDICATOR_COOKIES = {
	td: "yztrade_indicator_td",
	vwap: "yztrade_indicator_vwap",
	histogram: "yztrade_indicator_histogram",
};
export const PRICE_SCALE_COOKIES = {
	logarithmic: "yztrade_price_scale_logarithmic",
	inverted: "yztrade_price_scale_inverted",
};
export const BOOKMARKED_PRICE_COOKIE = "yztrade_bookmarked_price";
