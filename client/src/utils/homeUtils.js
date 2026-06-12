import {
	API_BASE,
	BOOKMARKED_PRICE_COOKIE,
	BUY_FEE_ESTIMATE_RATE,
	BUY_FEE_INCLUSIVE_MIN_TOTAL,
	CHART_TIME_ZONE,
	DEFAULT_BASE_CURRENCY,
	PRICE_PRECISION,
} from "./homeConstants";

export const getCookie = (name) => {
	if (typeof document === "undefined" || typeof document.cookie !== "string") return null;

	const prefix = `${encodeURIComponent(name)}=`;
	const cookie = document.cookie
		.split(";")
		.map(part => part.trim())
		.find(part => part.startsWith(prefix));

	return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null;
};

export const getCookieBoolean = (name, fallback = true) => {
	const value = getCookie(name);

	if (value === "1") return true;
	if (value === "0") return false;

	return fallback;
};

export const setCookieBoolean = (name, value) => {
	if (typeof document === "undefined" || typeof document.cookie !== "string") return;

	const maxAge = 60 * 60 * 24 * 365;

	document.cookie = `${encodeURIComponent(name)}=${value ? "1" : "0"}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
};

export const setCookieValue = (name, value) => {
	if (typeof document === "undefined" || typeof document.cookie !== "string") return;

	const maxAge = 60 * 60 * 24 * 365;

	document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
};

export const deleteCookie = (name) => {
	if (typeof document === "undefined" || typeof document.cookie !== "string") return;

	document.cookie = `${encodeURIComponent(name)}=; Max-Age=0; Path=/; SameSite=Lax`;
};

export const getBookmarkedPrice = (currency) => {
	const value = getCookie(BOOKMARKED_PRICE_COOKIE);
	const normalizedCurrency = String(currency || "").toUpperCase();

	if (!value || !normalizedCurrency) return null;

	try {
		const bookmarks = JSON.parse(value);

		if (bookmarks && typeof bookmarks === "object" && !Array.isArray(bookmarks)) {
			if (Object.prototype.hasOwnProperty.call(bookmarks, "currency")) {
				const price = Number(bookmarks.price);

				return String(bookmarks.currency || "").toUpperCase() === normalizedCurrency && Number.isFinite(price)
					? price
					: null;
			}

			const price = Number(bookmarks[normalizedCurrency]);

			return Number.isFinite(price) ? price : null;
		}
	} catch {
		return null;
	}

	return null;
};

export const setBookmarkedPrice = (currency, price) => {
	const numericPrice = Number(price);
	const normalizedCurrency = String(currency || "").toUpperCase();

	if (!normalizedCurrency || !Number.isFinite(numericPrice)) return;

	let bookmarks = {};
	const value = getCookie(BOOKMARKED_PRICE_COOKIE);

	if (value) {
		try {
			const parsed = JSON.parse(value);

			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				bookmarks = Object.prototype.hasOwnProperty.call(parsed, "currency")
					? { [String(parsed.currency || "").toUpperCase()]: Number(parsed.price) }
					: parsed;
			}
		} catch {
			bookmarks = {};
		}
	}

	setCookieValue(BOOKMARKED_PRICE_COOKIE, JSON.stringify({
		...bookmarks,
		[normalizedCurrency]: numericPrice,
	}));
};

export const deleteBookmarkedPrice = (currency) => {
	const normalizedCurrency = String(currency || "").toUpperCase();
	const value = getCookie(BOOKMARKED_PRICE_COOKIE);

	if (!normalizedCurrency || !value) return;

	try {
		const parsed = JSON.parse(value);
		const bookmarks = parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? Object.prototype.hasOwnProperty.call(parsed, "currency")
				? { [String(parsed.currency || "").toUpperCase()]: Number(parsed.price) }
				: { ...parsed }
			: {};

		delete bookmarks[normalizedCurrency];
		setCookieValue(BOOKMARKED_PRICE_COOKIE, JSON.stringify(bookmarks));
	} catch {
		deleteCookie(BOOKMARKED_PRICE_COOKIE);
	}
};

export const getWebSocketBase = () => {
	if (!API_BASE) {
		return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
	}

	if (API_BASE.startsWith("http://")) return API_BASE.replace(/^http:/, "ws:");
	if (API_BASE.startsWith("https://")) return API_BASE.replace(/^https:/, "wss:");

	return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${API_BASE}`;
};

export const getBaseCurrencyFromPath = (pathname = "") => {
	const segments = pathname
		.split("/")
		.map(part => part.trim())
		.filter(Boolean);
	const [firstSegment, secondSegment] = segments;
	const segment = firstSegment?.toLowerCase() === "trade" ? secondSegment : firstSegment;

	if (!segment) {
		return DEFAULT_BASE_CURRENCY;
	}

	return segment.replace(/[^a-z0-9]/gi, "").toUpperCase() || DEFAULT_BASE_CURRENCY;
};

export const getRoutePrefix = (pathname = "") => (
	pathname
		.split("/")
		.map(part => part.trim())
		.filter(Boolean)[0]?.toLowerCase() === "trade"
		? "/trade"
		: ""
);

export const getCurrencyFromProductId = (productId = "") => (
	String(productId || "").trim().toUpperCase().split("-", 1)[0] || "UNKNOWN"
);

export const formatPrice = (price) => (
	Number.isFinite(Number(price)) ? Number(price).toFixed(PRICE_PRECISION) : "--"
);

export const formatCompactPrice = (price) => {
	const numericPrice = Number(price);

	if (!Number.isFinite(numericPrice)) return "--";

	return numericPrice.toLocaleString("en-US", {
		minimumFractionDigits: 0,
		maximumFractionDigits: numericPrice >= 100 ? 2 : numericPrice >= 1 ? 4 : 8,
	});
};

export const formatOverlayPrice = (price) => {
	const numericPrice = Number(price);

	if (!Number.isFinite(numericPrice)) return "--";

	return numericPrice.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
};

export const getPrecisionFromIncrement = (increment) => {
	const value = String(increment || "").trim();

	if (!value || !Number.isFinite(Number(value))) return PRICE_PRECISION;

	const normalized = value.toLowerCase();

	if (normalized.includes("e-")) {
		return Math.max(0, Number(normalized.split("e-")[1]) || PRICE_PRECISION);
	}

	const decimalPart = normalized.split(".")[1] || "";

	return Math.max(0, decimalPart.replace(/0+$/, "").length);
};

export const formatPriceWithIncrement = (price, increment) => {
	const numericPrice = Number(price);

	if (!Number.isFinite(numericPrice)) return "--";

	return numericPrice.toFixed(getPrecisionFromIncrement(increment));
};

export const hasPriceIncrement = (increment) => (
	increment !== null
	&& increment !== undefined
	&& String(increment).trim() !== ""
	&& Number.isFinite(Number(increment))
);

export const formatDisplayPriceWithIncrement = (price, increment, fallbackPrecision = 2) => {
	const numericPrice = Number(price);

	if (!Number.isFinite(numericPrice)) return "--";

	const hasIncrement = hasPriceIncrement(increment);
	const precision = hasIncrement ? getPrecisionFromIncrement(increment) : fallbackPrecision;

	return numericPrice.toLocaleString("en-US", {
		minimumFractionDigits: precision,
		maximumFractionDigits: precision,
	});
};

export const formatAmountWithIncrementFloor = (amount, increment) => {
	const numericAmount = Number(amount);
	const numericIncrement = Number(increment);
	const precision = getPrecisionFromIncrement(increment);

	if (!Number.isFinite(numericAmount)) return "--";

	if (!Number.isFinite(numericIncrement) || numericIncrement <= 0) {
		const factor = 10 ** precision;
		const floored = Math.floor(Math.max(0, numericAmount) * factor) / factor;

		return floored.toFixed(precision);
	}

	const floored = Math.floor(Math.max(0, numericAmount) / numericIncrement) * numericIncrement;

	return floored.toFixed(precision);
};

export const formatUsdValue = (value) => {
	const numericValue = Number(value);

	if (!Number.isFinite(numericValue)) return "--";
	if (Math.abs(numericValue) >= 1_000_000) return `$${(numericValue / 1_000_000).toFixed(2)}M`;
	if (Math.abs(numericValue) >= 1_000) return `$${(numericValue / 1_000).toFixed(2)}K`;

	return `$${numericValue.toFixed(2)}`;
};

export const formatUsdFullValue = (value) => {
	const numericValue = Number(value);

	if (!Number.isFinite(numericValue)) return "--";

	return numericValue.toLocaleString(undefined, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
};

export const formatOrderValue = (totalValue, amount, price, quoteSize) => {
	const numericTotalValue = Number(totalValue);

	if (Number.isFinite(numericTotalValue)) {
		return formatUsdFullValue(numericTotalValue);
	}

	const numericAmount = Number(amount);
	const numericPrice = Number(price);

	if (Number.isFinite(numericAmount) && Number.isFinite(numericPrice)) {
		return formatUsdFullValue(numericAmount * numericPrice);
	}

	const numericQuoteSize = Number(quoteSize);

	return Number.isFinite(numericQuoteSize)
		? formatUsdFullValue(numericQuoteSize)
		: "--";
};

export const formatSignedPercent = (value) => {
	const numericValue = Number(value);

	if (!Number.isFinite(numericValue)) return "--";

	return `${numericValue >= 0 ? "+" : "-"}${Math.abs(numericValue).toFixed(2)}%`;
};

export const formatBalanceAmount = (value) => {
	const numericValue = Number(value);

	if (!Number.isFinite(numericValue)) return "--";
	if (Math.abs(numericValue) >= 1) return numericValue.toLocaleString(undefined, { maximumFractionDigits: 4 });

	return numericValue.toLocaleString(undefined, { maximumFractionDigits: 8 });
};

export const formatUsdCents = (value) => {
	const numericValue = Number(value);

	if (!Number.isFinite(numericValue)) return "--";

	return numericValue.toLocaleString(undefined, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
};

export const formatSignedUsdCents = (value) => {
	const numericValue = Number(value);

	if (!Number.isFinite(numericValue)) return "--";

	return `${numericValue >= 0 ? "+" : "-"}${formatUsdCents(Math.abs(numericValue))}`;
};

export const formatUsdAmountInput = (value) => {
	const numericValue = Number(value);

	if (!Number.isFinite(numericValue)) return "0";

	const floored = Math.floor(Math.max(0, numericValue) * 100) / 100;

	return floored.toFixed(2);
};

export const estimateBuyQuoteSizeFromTotal = (totalAmount) => {
	const numericTotal = Number(totalAmount);

	if (!Number.isFinite(numericTotal) || numericTotal <= 0) return 0;
	if (numericTotal < BUY_FEE_INCLUSIVE_MIN_TOTAL) return numericTotal;

	return numericTotal / (1 + BUY_FEE_ESTIMATE_RATE);
};

export const sanitizeNumericInput = (value) => {
	const rawValue = String(value || "").replace(/,/g, ".");
	let hasDecimal = false;

	return rawValue
		.split("")
		.filter(char => {
			if (char >= "0" && char <= "9") return true;

			if (char === "." && !hasDecimal) {
				hasDecimal = true;
				return true;
			}

			return false;
		})
		.join("");
};

export const getOrderErrorLabel = (detail, fallback = "Coinbase order error.") => {
	if (typeof detail === "string") return detail;

	const errs = Array.isArray(detail?.errs)
		? detail.errs
		: Array.isArray(detail?.preview?.errs)
			? detail.preview.errs
			: null;

	if (errs?.length) return String(errs[0]);
	if (detail?.error) return String(detail.error);
	if (detail?.message) return String(detail.message);

	return fallback;
};

export const chartTimeFormatter = new Intl.DateTimeFormat("en-US", {
	timeZone: CHART_TIME_ZONE,
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});

export const chartDayFormatter = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	day: "2-digit",
});

export const chartFullTimeFormatter = new Intl.DateTimeFormat("en-US", {
	timeZone: CHART_TIME_ZONE,
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});

export const formatChartEasternTime = (time, formatter = chartTimeFormatter) => {
	const timestamp = typeof time === "object"
		? Date.UTC(time.year, time.month - 1, time.day) / 1000
		: Number(time);

	if (!Number.isFinite(timestamp)) return "";

	return formatter.format(new Date(timestamp * 1000));
};

const vwapSessionFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: CHART_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

export const getVwapSessionKey = (time) => (
	vwapSessionFormatter.format(new Date(Number(time) * 1000))
);

export const formatMeasurementDuration = (seconds) => {
	const totalSeconds = Math.max(0, Math.round(Math.abs(Number(seconds) || 0)));
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);

	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;

	return `${minutes}m`;
};
