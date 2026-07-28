export const API_BASE = import.meta.env.VITE_API_BASE
	|| (typeof window !== "undefined" && window.location.pathname.startsWith("/trade") ? "/trade" : "");

const parsePositiveDays = (value, fallback) => {
	const days = Number(value);

	return Number.isFinite(days) && days > 0 ? days : fallback;
};

export const DISTRIBUTION_BINS = 160;
export const DEPTH_RANGE_PADDING = 1.2;
export const DEPTH_CHART_PADDING_RATIO = 0.09;
export const MIN_DEPTH_WIDTH_RATIO = 0.1;
export const DEFAULT_PERIOD_DAYS = 5;
export const MAX_VISIBLE_PERIOD_DAYS = parsePositiveDays(
	import.meta.env.CHART_MAX_VISIBLE_DAYS,
	20,
);
export const DEFAULT_CANDLE_GRANULARITY = 300;
export const CANDLE_GRANULARITY_COOKIE = "yztrade_candle_granularity";
export const CANDLE_GRANULARITY_OPTIONS = [
	{ seconds: 60, label: "1m", periodDays: parsePositiveDays(import.meta.env.CHART_LOAD_DAYS_1M, 1) },
	{ seconds: 300, label: "5m", periodDays: parsePositiveDays(import.meta.env.CHART_LOAD_DAYS_5M, 4) },
	{ seconds: 3600, label: "1h", periodDays: parsePositiveDays(import.meta.env.CHART_LOAD_DAYS_1H, 7) },
	{ seconds: 14400, label: "4h", periodDays: parsePositiveDays(import.meta.env.CHART_LOAD_DAYS_4H, 14) },
];
export const CANDLE_GRANULARITY_SECONDS = new Set(
	CANDLE_GRANULARITY_OPTIONS.map(option => option.seconds),
);
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
	r6: "yztrade_indicator_r6",
	macd: "yztrade_indicator_macd",
	pvt: "yztrade_indicator_pvt",
	lims24: "yztrade_indicator_lims24",
};
export const PRICE_SCALE_COOKIES = {
	logarithmic: "yztrade_price_scale_logarithmic",
	inverted: "yztrade_price_scale_inverted",
};
export const BOOKMARKED_PRICE_COOKIE = "yztrade_bookmarked_price";
