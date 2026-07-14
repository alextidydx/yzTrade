import {
	API_BASE,
	BOOKMARKED_PRICE_COOKIE,
	CHART_TIME_ZONE,
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

	const closedMarkers = ["CANCEL", "FILLED", "EXPIRED", "FAILED", "REJECTED"];

	return !closedMarkers.some(marker => normalized.includes(marker));
};

export const filterOrdersForChartProduct = (orders, productId) => {
	const normalizedProductId = String(productId || "").trim().toUpperCase();
	const selectedBaseCurrency = getCurrencyFromProductId(normalizedProductId);
	const normalizedOrders = Array.isArray(orders) ? orders : [];
	const exactMatches = normalizedOrders.filter(
		order => String(order?.product_id || "").trim().toUpperCase() === normalizedProductId,
	);

	if (exactMatches.length) {
		return exactMatches;
	}

	return normalizedOrders.filter(
		order => getCurrencyFromProductId(order?.product_id) === selectedBaseCurrency,
	);
};

export const isRemovedLiveOrder = (order, removedOrderIds) => {
	if (!order?.id) return true;

	if (removedOrderIds.has(order.id)) return true;
	if (order.cancel_id && removedOrderIds.has(order.cancel_id)) return true;
	if (order.parent_id && removedOrderIds.has(order.parent_id)) return true;

	return false;
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

export const formatOrderValue = (totalValue, amount, price, quoteSize, orderTotal) => {
	const numericOrderTotal = Number(orderTotal);

	if (Number.isFinite(numericOrderTotal) && numericOrderTotal > 0) {
		return formatUsdFullValue(numericOrderTotal);
	}

	const numericTotalValue = Number(totalValue);

	if (Number.isFinite(numericTotalValue) && numericTotalValue > 0) {
		return formatUsdFullValue(numericTotalValue);
	}

	const numericQuoteSize = Number(quoteSize);

	if (Number.isFinite(numericQuoteSize) && numericQuoteSize > 0) {
		return formatUsdFullValue(numericQuoteSize);
	}

	const numericAmount = Number(amount);
	const numericPrice = Number(price);

	if (Number.isFinite(numericAmount) && numericAmount > 0 && Number.isFinite(numericPrice) && numericPrice > 0) {
		return formatUsdFullValue(numericAmount * numericPrice);
	}

	return "--";
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

export const getOrderTotalBaseSize = (order) => resolveOrderTotalBaseSize(order);

export const getOrderDisplayAmount = (order) => {
	const remaining = Number(order?.amount);

	if (Number.isFinite(remaining) && remaining > 0) {
		return remaining;
	}

	const totalBaseSize = resolveOrderTotalBaseSize(order);

	if (Number.isFinite(totalBaseSize) && totalBaseSize > 0) {
		return totalBaseSize;
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

	return enrichOrderForDisplay(merged);
};

export const buildOptimisticOrderFromPlacement = ({ body, preview, response } = {}) => {
	if (!preview) return null;

	const price = Number(body?.limit_price ?? body?.stop_price ?? preview?.limit_price);
	const baseSize = Number(preview?.base_size);
	const quoteSize = Number(preview?.quote_size);
	const orderTotal = Number(preview?.order_total);
	const commissionTotal = Number(preview?.commission_total);

	if (!Number.isFinite(baseSize) || baseSize <= 0) return null;

	const orderId = response?.data?.order?.id
		|| response?.data?.success_response?.order_id
		|| response?.data?.order_id
		|| `pending-${Date.now()}`;

	const placedOrder = response?.data?.order;

	if (placedOrder) {
		return enrichOrderForDisplay(placedOrder);
	}

	return enrichOrderForDisplay({
		id: orderId,
		product_id: body?.product_id,
		side: String(body?.side || preview?.side || "").toLowerCase(),
		price: Number.isFinite(price) ? price : null,
		amount: baseSize,
		base_size: baseSize,
		quote_size: Number.isFinite(quoteSize) && quoteSize > 0 ? quoteSize : null,
		order_total: Number.isFinite(orderTotal) && orderTotal > 0 ? orderTotal : null,
		total_value: Number.isFinite(orderTotal) && orderTotal > 0 ? orderTotal : null,
		commission_total: Number.isFinite(commissionTotal) ? commissionTotal : null,
		filled_percent: 0,
		bracket_legs: [],
		status: "OPEN",
	});
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

export const getSellUsdOrderTicketSummary = (enteredAmount, preview) => (
	getSellPreviewTicketSummary(preview, enteredAmount)
);

export const getSellOrderTicketSummary = (preview) => (
	getSellPreviewTicketSummary(preview)
);

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
};

export const getOrderErrorLabel = (detail, fallback = "Coinbase order error.", context = {}) => {
	if (typeof detail === "string") return detail;

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
