import {
	API_BASE,
	BOOKMARKED_PRICE_COOKIE,
	CANDLE_GRANULARITY_COOKIE,
	CANDLE_GRANULARITY_OPTIONS,
	CANDLE_GRANULARITY_SECONDS,
	CHART_TIME_ZONE,
	DEFAULT_CANDLE_GRANULARITY,
	DEFAULT_PERIOD_DAYS,
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

export const normalizeBookmarkPrice = (price) => {
	const numeric = Number(price);

	return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const BALANCE_HISTORY_PERIODS = new Set(["day", "week", "30d", "all"]);

export const normalizeBalanceHistoryPeriod = (period, fallback = "week") => {
	const normalized = String(period || "").trim().toLowerCase();

	return BALANCE_HISTORY_PERIODS.has(normalized) ? normalized : fallback;
};

export const normalizeCandleGranularity = (value, fallback = DEFAULT_CANDLE_GRANULARITY) => {
	const numeric = Number(value);

	if (CANDLE_GRANULARITY_SECONDS.has(numeric)) {
		return numeric;
	}

	return fallback;
};

export const getCandleGranularityLabel = (seconds) => {
	const match = CANDLE_GRANULARITY_OPTIONS.find(option => option.seconds === Number(seconds));

	return match?.label || "5m";
};

export const getPeriodDaysForGranularity = (seconds) => {
	const match = CANDLE_GRANULARITY_OPTIONS.find(option => option.seconds === Number(seconds));

	return Number.isFinite(Number(match?.periodDays)) && Number(match.periodDays) > 0
		? Number(match.periodDays)
		: DEFAULT_PERIOD_DAYS;
};

export const getCandleGranularity = () => (
	normalizeCandleGranularity(getCookie(CANDLE_GRANULARITY_COOKIE))
);

export const setCandleGranularityCookie = (seconds) => {
	const normalized = normalizeCandleGranularity(seconds);

	setCookieValue(CANDLE_GRANULARITY_COOKIE, String(normalized));

	return normalized;
};

export const getBookmarkedPrice = (currency) => {
	const value = getCookie(BOOKMARKED_PRICE_COOKIE);
	const normalizedCurrency = String(currency || "").toUpperCase();

	if (!value || !normalizedCurrency) return null;

	try {
		const bookmarks = JSON.parse(value);

		if (bookmarks && typeof bookmarks === "object" && !Array.isArray(bookmarks)) {
			if (Object.prototype.hasOwnProperty.call(bookmarks, "currency")) {
				const price = normalizeBookmarkPrice(bookmarks.price);

				return String(bookmarks.currency || "").toUpperCase() === normalizedCurrency
					? price
					: null;
			}

			return normalizeBookmarkPrice(bookmarks[normalizedCurrency]);
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

export const getBaseCurrencyFromPath = (pathname = "", defaultBaseCurrency = "") => {
	const segments = pathname
		.split("/")
		.map(part => part.trim())
		.filter(Boolean);
	const [firstSegment, secondSegment] = segments;
	const segment = firstSegment?.toLowerCase() === "trade" ? secondSegment : firstSegment;

	if (!segment) {
		return defaultBaseCurrency;
	}

	return segment.replace(/[^a-z0-9]/gi, "").toUpperCase() || defaultBaseCurrency;
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

export const isOpenOrderStatus = (status) => {
	const normalized = String(status || "").toUpperCase();

	if (!normalized) return true;

	if (["OPEN", "PENDING", "QUEUED", "ACTIVE", "PARTIALLY_FILLED"].includes(normalized)) {
		return true;
	}

	if (["FILLED", "CANCELLED", "CANCELED", "EXPIRED", "FAILED", "REJECTED"].includes(normalized)) {
		return false;
	}

	if (normalized.includes("PARTIALLY")) {
		return true;
	}

	const closedMarkers = ["CANCEL", "FILLED", "EXPIRED", "FAILED", "REJECTED", "ERROR"];

	return !closedMarkers.some(marker => normalized.includes(marker));
};

export const isErrorOrderStatus = (status) => (
	String(status || "").toUpperCase() === "ERROR"
);

export const isDisplayableOrderStatus = (status) => (
	isOpenOrderStatus(status) || isErrorOrderStatus(status)
);

export const filterOrdersForChartProduct = (orders, productId) => {
	const normalizedProductId = String(productId || "").trim().toUpperCase();
	const selectedBaseCurrency = getCurrencyFromProductId(normalizedProductId);
	const normalizedOrders = Array.isArray(orders) ? orders : [];

	if (!selectedBaseCurrency) return [];

	return normalizedOrders.filter(
		order => getCurrencyFromProductId(order?.product_id) === selectedBaseCurrency,
	);
};

export const getOrderIdentityKey = (order) => {
	return String(order?.original_id || "").trim();
};

export const findOrderEditIndex = (orders, orderId) => {
	const id = String(orderId || "");
	const list = Array.isArray(orders) ? orders : [];

	if (!id) return -1;

	return list.findIndex(order => String(order?.original_id || "") === id);
};

export const uniqueOrdersByOriginalId = (orders) => {
	const byOriginalId = new Map();

	(Array.isArray(orders) ? orders : []).forEach(order => {
		if (!order) return;

		const originalId = String(order.original_id || "").trim();
		if (!originalId) return;

		byOriginalId.set(originalId, {
			...order,
			original_id: originalId,
		});
	});

	return Array.from(byOriginalId.values());
};

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

/** Single dollar total for dropdown + chart line (same field source). */
export const getOrderDisplayTotalUsd = (order) => {
	if (!order || typeof order !== "object") return NaN;

	const role = String(order.role || "").toLowerCase();
	const isBracketLeg = role === "take_profit" || role === "stop_loss";
	const orderType = String(order.order_type || "").toUpperCase();
	const side = String(order.side || "").toLowerCase();

	// Bracket parent (orders list): same $ as chart TP line — TP leg total only.
	if (!isBracketLeg && orderType === "BRACKET") {
		const legs = Array.isArray(order.bracket_legs) ? order.bracket_legs : [];
		const tpLeg = legs.find((leg) => String(leg?.role || "").toLowerCase() === "take_profit");
		const tpTotal = Number(tpLeg?.total_value ?? tpLeg?.order_total);
		if (Number.isFinite(tpTotal) && tpTotal > 0) return tpTotal;
		const tpAmount = Number(tpLeg?.amount ?? tpLeg?.base_size);
		const tpPrice = Number(tpLeg?.price);
		if (Number.isFinite(tpAmount) && tpAmount > 0 && Number.isFinite(tpPrice) && tpPrice > 0) {
			return tpAmount * tpPrice;
		}
	}

	// Tracked BUY: always show ORIGINAL $ — never remaining / leftover order_total.
	if (!isBracketLeg && side === "buy") {
		const original = Number(order.original_value_usd);
		if (Number.isFinite(original) && original > 0) return original;
	}

	// Explicit stamped / live totals (SELL, untracked BUY, drag size × draft).
	const orderTotal = Number(order.order_total);
	if (Number.isFinite(orderTotal) && orderTotal > 0) return orderTotal;

	const totalValue = Number(order.total_value);
	if (Number.isFinite(totalValue) && totalValue > 0) return totalValue;

	const quoteSize = Number(order.quote_size);
	if (Number.isFinite(quoteSize) && quoteSize > 0) return quoteSize;

	// Limit + TP/SL: size × price (live drag and resting fallback).
	const amount = Number(order.amount ?? order.base_size ?? order.total_base_size);
	const price = Number(order.price);

	if (Number.isFinite(amount) && amount > 0 && Number.isFinite(price) && price > 0) {
		return amount * price;
	}

	return NaN;
};

export const formatOrderDisplayTotal = (order) => {
	const value = getOrderDisplayTotalUsd(order);

	return Number.isFinite(value) && value > 0 ? formatUsdFullValue(value) : "--";
};

// Bracket TP/SL $ after fee. Fee is scaled from the TP preview fee by exit price / TP price.
export const getBracketExitUsdValue = ({
	amount,
	price,
	referencePrice,
	commissionTotal,
	side = "sell",
} = {}) => {
	const size = Number(amount);
	const exitPrice = Number(price);

	if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(exitPrice) || exitPrice <= 0) {
		return NaN;
	}

	const gross = size * exitPrice;
	const fee = Number(commissionTotal);

	if (!Number.isFinite(fee) || fee < 0) {
		return gross;
	}

	const tpPrice = Number(referencePrice);
	const scaledFee = Number.isFinite(tpPrice) && tpPrice > 0
		? fee * (exitPrice / tpPrice)
		: fee;

	if (String(side || "").toLowerCase() === "buy") {
		return gross + scaledFee;
	}

	return Math.max(0, gross - scaledFee);
};

export const resolveOrderTotalBaseSize = (order) => {
	if (!order || typeof order !== "object") return null;

	const explicitTotal = Number(order.total_base_size);

	if (Number.isFinite(explicitTotal) && explicitTotal > 0) {
		return explicitTotal;
	}

	const filledSize = Number(order.filled_size);
	const leavesQuantity = Number(order.leaves_quantity);

	if (
		Number.isFinite(filledSize)
		&& filledSize >= 0
		&& Number.isFinite(leavesQuantity)
		&& leavesQuantity >= 0
	) {
		const totalFromFill = filledSize + leavesQuantity;

		if (totalFromFill > 0) {
			return totalFromFill;
		}
	}

	const baseSize = Number(order.base_size);

	if (Number.isFinite(baseSize) && baseSize > 0) {
		return baseSize;
	}

	const side = String(order.side || "").toUpperCase();
	const price = Number(order.price);
	const quoteSize = Number(order.quote_size);
	const orderTotal = Number(order.order_total);
	const commissionTotal = Number(order.commission_total);

	if (side === "BUY") {
		if (Number.isFinite(quoteSize) && quoteSize > 0 && Number.isFinite(price) && price > 0) {
			return quoteSize / price;
		}

		if (Number.isFinite(orderTotal) && orderTotal > 0 && Number.isFinite(price) && price > 0) {
			const netUsd = Number.isFinite(commissionTotal) && commissionTotal >= 0
				? orderTotal - commissionTotal
				: orderTotal;

			return netUsd / price;
		}
	}

	return null;
};

export const getOrderDisplayAmount = (order) => {
	const totalBaseSize = resolveOrderTotalBaseSize(order);

	if (Number.isFinite(totalBaseSize) && totalBaseSize > 0) {
		return totalBaseSize;
	}

	const amount = Number(order?.amount);

	if (Number.isFinite(amount) && amount > 0) {
		return amount;
	}

	return null;
};

export const getOrderFilledPercent = (order) => {
	const filledSize = Number(order?.filled_size);
	const totalBaseSize = resolveOrderTotalBaseSize(order);

	if (Number.isFinite(filledSize) && filledSize >= 0 && Number.isFinite(totalBaseSize) && totalBaseSize > 0) {
		return Math.max(0, Math.min(100, (filledSize / totalBaseSize) * 100));
	}

	return null;
};

const ORDER_VALUE_FIELDS = ["quote_size", "total_value", "order_total", "commission_total", "leaves_quantity"];
const ORDER_SIZE_FIELDS = ["amount", "base_size", "total_base_size"];

export const enrichOrderForDisplay = (order) => {
	if (!order || typeof order !== "object") return order;

	const displayAmount = getOrderDisplayAmount(order);
	const totalBaseSize = resolveOrderTotalBaseSize(order);
	const filledPercent = getOrderFilledPercent(order);
	const orderTotal = Number(order.order_total);
	const totalValue = Number(order.total_value);
	const quoteSize = Number(order.quote_size);
	const commissionTotal = Number(order.commission_total);
	const enriched = { ...order };

	if (Number.isFinite(displayAmount) && displayAmount > 0) {
		enriched.amount = displayAmount;
	}

	if (Number.isFinite(totalBaseSize) && totalBaseSize > 0) {
		enriched.total_base_size = totalBaseSize;
	} else {
		delete enriched.total_base_size;
	}

	if (Number.isFinite(filledPercent)) {
		enriched.filled_percent = filledPercent;
	} else {
		delete enriched.filled_percent;
	}

	if (Number.isFinite(orderTotal) && orderTotal > 0) {
		enriched.order_total = orderTotal;
		enriched.total_value = orderTotal;
	} else if (Number.isFinite(totalValue) && totalValue > 0) {
		enriched.total_value = totalValue;
	} else if (Number.isFinite(quoteSize) && quoteSize > 0) {
		enriched.total_value = quoteSize;
	}

	if (Number.isFinite(quoteSize) && quoteSize > 0) {
		enriched.quote_size = quoteSize;
	}

	if (Number.isFinite(commissionTotal) && commissionTotal >= 0) {
		enriched.commission_total = commissionTotal;
	}

	return enriched;
};

export const mergeOrderFields = (existing, incoming) => {
	const merged = { ...(existing || {}), ...(incoming || {}) };

	if (!merged.original_id && existing?.original_id) {
		merged.original_id = existing.original_id;
	}

	const trackingFields = [
		"original_value_usd",
		"used_value_usd",
		"remaining_value_usd",
		"used_percent",
		"used_before_current_order_usd",
	];

	trackingFields.forEach((key) => {
		const nextValue = Number(merged[key]);
		const prevValue = Number(existing?.[key]);

		if ((!Number.isFinite(nextValue) || nextValue < 0) && Number.isFinite(prevValue) && prevValue >= 0) {
			merged[key] = existing[key];
			return;
		}

		// Parent USED/ORIGINAL must not be wiped to 0 by an empty child leg snapshot.
		if (
			(key === "used_value_usd" || key === "used_percent" || key === "original_value_usd")
			&& Number.isFinite(prevValue)
			&& prevValue > 0
			&& Number.isFinite(nextValue)
			&& nextValue === 0
		) {
			merged[key] = existing[key];
		}
	});

	ORDER_VALUE_FIELDS.forEach((key) => {
		const nextValue = Number(merged[key]);
		const prevValue = Number(existing?.[key]);

		if ((!Number.isFinite(nextValue) || nextValue <= 0) && Number.isFinite(prevValue) && prevValue > 0) {
			merged[key] = existing[key];
		}
	});

	ORDER_SIZE_FIELDS.forEach((key) => {
		const nextValue = Number(merged[key]);
		const prevValue = Number(existing?.[key]);

		if ((!Number.isFinite(nextValue) || nextValue <= 0) && Number.isFinite(prevValue) && prevValue > 0) {
			merged[key] = existing[key];
		}
	});

	const incomingFilled = Number(incoming?.filled_size);
	const prevFilled = Number(existing?.filled_size);

	if (Number.isFinite(incomingFilled) && incomingFilled >= 0) {
		merged.filled_size = Number.isFinite(prevFilled)
			? Math.max(prevFilled, incomingFilled)
			: incomingFilled;
	} else if (Number.isFinite(prevFilled) && prevFilled >= 0) {
		merged.filled_size = prevFilled;
	}

	const prevTotal = resolveOrderTotalBaseSize(existing);
	const nextTotal = resolveOrderTotalBaseSize({
		...merged,
		total_base_size: undefined,
	});
	let stableTotal = null;

	if (Number.isFinite(prevTotal) && Number.isFinite(nextTotal)) {
		stableTotal = Math.max(prevTotal, nextTotal);
	} else {
		stableTotal = nextTotal ?? prevTotal;
	}

	if (Number.isFinite(stableTotal) && stableTotal > 0) {
		merged.total_base_size = stableTotal;
	}

	if (
		(!Array.isArray(merged.bracket_legs) || !merged.bracket_legs.length)
		&& Array.isArray(existing?.bracket_legs)
		&& existing.bracket_legs.length
	) {
		merged.bracket_legs = existing.bracket_legs;
	}

	const existingType = String(existing?.order_type || "").toUpperCase();
	const incomingType = String(incoming?.order_type || "").toUpperCase();
	if (
		existingType
		&& existingType !== "UNKNOWN"
		&& (
			!incomingType
			|| (
				existingType === "BRACKET"
				&& incomingType !== "BRACKET"
				&& (!Array.isArray(incoming?.bracket_legs) || !incoming.bracket_legs.length)
			)
		)
	) {
		merged.order_type = existing.order_type;
	}

	const nextPrice = Number(incoming?.price);
	const prevPrice = Number(existing?.price);
	if (
		(!Number.isFinite(nextPrice) || nextPrice <= 0)
		&& Number.isFinite(prevPrice)
		&& prevPrice > 0
	) {
		merged.price = existing.price;
	}

	delete merged.ui_price_lock;

	return enrichOrderForDisplay(merged);
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

export const floorQuoteCurrencyAmount = (value) => {
	const numericValue = Number(value);

	if (!Number.isFinite(numericValue) || numericValue <= 0) return 0;

	return Math.floor(numericValue * 100) / 100;
};

// BUY USD Total is always the entered/max $ amount — never preview order_total (fee-adjusted net).
export const getBuyUsdOrderTicketSummary = (enteredAmount, preview) => {
	const total = floorQuoteCurrencyAmount(enteredAmount);
	const fee = Number(preview?.commission_total);

	if (!Number.isFinite(total) || total <= 0) {
		return null;
	}

	const hasFee = Number.isFinite(fee) && fee >= 0;
	const value = hasFee ? Math.max(0, total - fee) : NaN;

	return {
		total,
		value,
		fee: hasFee ? fee : NaN,
	};
};

export const getSellPreviewTicketSummary = (preview, enteredAmount = null) => {
	if (!preview || typeof preview !== "object") {
		const enteredTotal = floorQuoteCurrencyAmount(enteredAmount);

		if (!Number.isFinite(enteredTotal) || enteredTotal <= 0) {
			return null;
		}

		return {
			total: enteredTotal,
			value: enteredTotal,
			fee: NaN,
		};
	}

	const fee = Number(preview.commission_total);
	const hasFee = Number.isFinite(fee) && fee >= 0;
	let orderTotal = floorQuoteCurrencyAmount(preview.order_total);

	if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
		orderTotal = floorQuoteCurrencyAmount(preview.quote_size);
	}

	if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
		return null;
	}

	return {
		total: hasFee ? floorQuoteCurrencyAmount(orderTotal + fee) : orderTotal,
		value: orderTotal,
		fee: hasFee ? fee : NaN,
	};
};

export const getBuyUsdPreviewQuoteSize = (enteredAmount) => floorQuoteCurrencyAmount(enteredAmount);

export const getOrderPreviewBaseSize = (preview) => {
	if (!preview || typeof preview !== "object") return NaN;

	const baseSize = Number(preview.base_size);

	if (Number.isFinite(baseSize) && baseSize > 0) {
		return baseSize;
	}

	return NaN;
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

const COINBASE_ORDER_ERROR_LABELS = {
	PREVIEW_STOP_PRICE_BELOW_LAST_TRADE_PRICE: ({ side } = {}) => (
		side === "BUY"
			? "Stop price must be above the current price for buy stop orders."
			: "Stop price must be below the current price for sell stop orders."
	),
	PREVIEW_STOP_PRICE_ABOVE_LAST_TRADE_PRICE: ({ side } = {}) => (
		side === "SELL"
			? "Stop price must be below the current price for sell stop orders."
			: "Stop price must be above the current price for buy stop orders."
	),
	PREVIEW_STOP_PRICE_ABOVE_LIMIT_PRICE: "Limit price must be at or above the stop price.",
	PREVIEW_STOP_PRICE_BELOW_LIMIT_PRICE: "Limit price must be at or below the stop price.",
	PREVIEW_INVALID_LIMIT_PRICE: "Enter a valid limit price.",
	PREVIEW_INVALID_STOP_PRICE: "Enter a valid stop price.",
	PREVIEW_INSUFFICIENT_FUND: "Insufficient balance. Lower the amount or leave room for the fee.",
	PREVIEW_INSUFFICIENT_FUNDS: "Insufficient balance. Lower the amount or leave room for the fee.",
	PREVIEW_INSUFFICIENT_FUNDS_FOR_ORDER: "Insufficient balance. Lower the amount or leave room for the fee.",
	CANNOT_EDIT_TO_BELOW_FILLED_SIZE: "Can't edit below the filled size.",
};

const firstEditFailureReason = (detail) => {
	if (detail == null) return "";

	if (typeof detail === "string") {
		const match = detail.match(/CANNOT_EDIT_TO_BELOW_FILLED_SIZE/);
		if (match) return match[0];
		try {
			return firstEditFailureReason(JSON.parse(detail));
		} catch {
			return "";
		}
	}

	if (Array.isArray(detail)) {
		for (const item of detail) {
			const reason = firstEditFailureReason(item);
			if (reason) return reason;
		}
		return "";
	}

	if (typeof detail === "object") {
		const direct = String(
			detail.edit_failure_reason
			|| detail.failure_reason
			|| detail.error
			|| "",
		).trim();
		if (direct) return direct;
		if (detail.detail != null) return firstEditFailureReason(detail.detail);
		if (Array.isArray(detail.errs)) return firstEditFailureReason(detail.errs);
	}

	return "";
};

export const getOrderErrorLabel = (detail, fallback = "Coinbase order error.", context = {}) => {
	if (typeof detail === "string") {
		const mapped = COINBASE_ORDER_ERROR_LABELS[detail]
			|| COINBASE_ORDER_ERROR_LABELS[firstEditFailureReason(detail)];
		if (typeof mapped === "function") return mapped(context);
		if (typeof mapped === "string") return mapped;
		return detail;
	}

	const failureReason = firstEditFailureReason(detail);
	if (failureReason) {
		const mapped = COINBASE_ORDER_ERROR_LABELS[failureReason];
		if (typeof mapped === "function") return mapped(context);
		if (typeof mapped === "string") return mapped;
	}

	const errs = Array.isArray(detail?.errs)
		? detail.errs
		: Array.isArray(detail?.preview?.errs)
			? detail.preview.errs
			: null;

	if (errs?.length) {
		const code = String(errs[0]);
		const label = COINBASE_ORDER_ERROR_LABELS[code];

		if (typeof label === "function") return label(context);
		if (typeof label === "string") return label;

		return code;
	}

	if (detail?.error) return String(detail.error);
	if (detail?.message) return String(detail.message);

	return fallback;
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
