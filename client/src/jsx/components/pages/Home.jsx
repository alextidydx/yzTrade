import React from 'react';
import classNames from "classnames";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import * as api from "../../../api";
import '../../../styles/ui/home.scss';
import '../../../styles/ui/dropdownShared.scss';
import BalanceDropdown from "../ui/BalanceDropdown";
import CoinsDropdown from "../ui/CoinsDropdown";
import OrderBubble from "../ui/OrderBubble";
import OrdersDropdown from "../ui/OrdersDropdown";

import {
	createChart,
	CandlestickSeries,
	CrosshairMode,
	HistogramSeries,
	LineSeries,
	LineType,
	MismatchDirection,
	PriceScaleMode,
} from 'lightweight-charts';

import {
	DEFAULT_DEPTH_CHART_WIDTH_RATIO,
	DEFAULT_PERIOD_DAYS,
	CANDLE_GRANULARITY_OPTIONS,
	MAX_VISIBLE_PERIOD_DAYS,
	DEPTH_CHART_PADDING_RATIO,
	DISTRIBUTION_BINS,
	DROPDOWN_TRANSITION_MS,
	INDICATOR_COOKIES,
	MIN_DEPTH_WIDTH_RATIO,
	MARKET_PREVIEW_POLL_INTERVAL_MS,
	ORDER_TICKET_ANCHOR_OFFSET_Y,
	ORDER_TICKET_FALLBACK_HEIGHT,
	ORDER_TICKET_RIGHT_OFFSET,
	OPEN_ORDER_EDIT_ERROR_FLASH_MS,
	PRICE_MIN_MOVE,
	PRICE_SCALE_COOKIES,
	HUD_COOKIE,
	TD_REFRESH_RETRY_DELAYS,
	TD_TIMEFRAME_SECONDS,
	TRAILING_PERCENT_COOKIE,
} from "../../../utils/homeConstants";

import {
	deleteBookmarkedPrice,
	formatAmountWithIncrementFloor,
	formatBalanceAmount,
	formatDisplayPriceWithIncrement,
	formatMeasurementDuration,
	formatOrderDisplayTotal,
	getBracketExitUsdValue,
	formatOverlayPrice,
	formatPrice,
	formatPriceWithIncrement,
	formatSignedPercent,
	formatSignedUsdCents,
	formatUsdAmountInput,
	formatUsdCents,
	formatUsdValue,
	getBaseCurrencyFromPath,
	getBookmarkedPrice,
	getCandleGranularity,
	getCandleGranularityLabel,
	getCookie,
	getCookieBoolean,
	getPeriodDaysForGranularity,
	enrichOrderForDisplay,
	filterOrdersForChartProduct,
	floorQuoteCurrencyAmount,
	getBuyUsdOrderTicketSummary,
	getBuyUsdPreviewQuoteSize,
	getSellPreviewTicketSummary,
	getOrderPreviewBaseSize,
	getOrderErrorLabel,
	isOpenOrderStatus,
	isDisplayableOrderStatus,
	isErrorOrderStatus,
	getOrderIdentityKey,
	findOrderEditIndex,
	uniqueOrdersByOriginalId,
	mergeOrderFields,
	normalizeBalanceHistoryPeriod,
	normalizeBookmarkPrice,
	normalizeCandleGranularity,
	getCurrencyFromProductId,
	getOrderDisplayAmount,
	getRoutePrefix,
	getPrecisionFromIncrement,
	getVwapSessionKey,
	getWebSocketBase,
	hasPriceIncrement,
	sanitizeNumericInput,
	setBookmarkedPrice,
	setCandleGranularityCookie,
	setCookieBoolean,
	setCookieValue,
} from "../../../utils/homeUtils";
import {
	formatChartCrosshairTime,
	toChartData,
	toChartPoint,
	toChartTime,
} from "../../../utils/chartTime";
export default (props) => (
	<Home {...props} payload={useParams()} history={useLocation()} navigate={useNavigate()} />
);

const APP_STATE_STALE_TIMEOUT_MS = 15000;
const LIVE_STALE_TIMEOUT_MS = 60000;
const LIVE_CONNECT_TIMEOUT_MS = 15000;
const PROFILE_REFRESH_INTERVAL_MS = 15000;
const ALL_ORDERS_REFRESH_INTERVAL_MS = 15000;
// REST polls after a confirmed move that may still return the pre-move price (Coinbase historical lag).
const POLLS_AFTER_MOVE_MAX = 2;
const AVG_ENTRY_REFRESH_INTERVAL_MS = 15000;
const AVG_ENTRY_RETRY_BASE_MS = 1000;
const AVG_ENTRY_RETRY_MAX_MS = 8000;
const AVG_ENTRY_RETRY_MAX_ATTEMPTS = 5;
const PARTIAL_FILL_BALANCE_DEBOUNCE_MS = 500;
const OLDER_CANDLES_INTERACTION_IDLE_MS = 220;
const OLDER_CANDLES_BATCH_SIZE = 300;
const OLDER_CANDLES_RETRY_MS = 1500;
const BULLSEYE_LOCK_NOTICE_DEBOUNCE_MS = 300;
const CHART_NOTICE_DURATION_MS = 3000;
const MACD_FAST_PERIOD = 12;
const MACD_SLOW_PERIOD = 26;
const MACD_SIGNAL_PERIOD = 9;
const CHART_TIME_SCALE_HEIGHT = 34;
const DEFAULT_PRICE_SCALE_MARGINS = { top: 0.08, bottom: 0.24 };
const FRAME_24H_PRICE_SCALE_MARGINS = { top: 1 / 3, bottom: 1 / 3 };
const BRACKET_DEFAULT_TAKE_PROFIT_FACTOR = 1.01;
const BRACKET_DEFAULT_STOP_LOSS_FACTOR = 0.998;
const TRAILING_DEFAULT_PERCENT = "5";
// Leave a few cents so MAX $-buys still clear fee/size rounding after base_size place.
const BUY_USD_MAX_HEADROOM = 0.05;
const AVG_ENTRY_MIN_USD = 1;

// Continuous price-scale zoom: factor = exp(deltaY * scale), clamped per frame.
// ~100px (typical mouse notch) ≈ ×1.10; tiny Mac trackpad deltas stay smooth.
const PRICE_SCALE_WHEEL_DELTA_SCALE = 0.001;
const PRICE_SCALE_WHEEL_FACTOR_MIN = 0.9;
const PRICE_SCALE_WHEEL_FACTOR_MAX = 1.1;

const normalizePriceScaleWheelDeltaY = (event) => {
	const deltaY = Number(event?.deltaY) || 0;

	// 0 = pixel, 1 = line, 2 = page
	if (event?.deltaMode === 1) return deltaY * 40;
	if (event?.deltaMode === 2) return deltaY * 800;

	return deltaY;
};

const priceScaleZoomFactorFromDelta = (normDeltaY) => {
	if (!Number.isFinite(normDeltaY) || normDeltaY === 0) return null;

	const raw = Math.exp(normDeltaY * PRICE_SCALE_WHEEL_DELTA_SCALE);

	return Math.min(
		PRICE_SCALE_WHEEL_FACTOR_MAX,
		Math.max(PRICE_SCALE_WHEEL_FACTOR_MIN, raw),
	);
};
// Match LWC logFormulaForPriceRange (seed freeze only — never recompute mid-zoom).

const spanRatioSuspect = (beforeMin, beforeMax, afterMin, afterMax) => {
	const beforeSpan = Number(beforeMax) - Number(beforeMin);
	const afterSpan = Number(afterMax) - Number(afterMin);

	if (!(beforeSpan > 0) || !(afterSpan > 0)) return false;

	const ratio = afterSpan / beforeSpan;

	return ratio >= 8 || ratio <= (1 / 8);
};

const LWC_LOG_LOGICAL_OFFSET = 4;
const LWC_LOG_COORD_OFFSET = 0.0001;

const DEFAULT_LWC_LOG_FORMULA = {
	logicalOffset: LWC_LOG_LOGICAL_OFFSET,
	coordOffset: LWC_LOG_COORD_OFFSET,
};

const getLightweightChartsLogFormula = (min, max) => {
	const diff = Math.abs(Number(max) - Number(min));

	if (!(diff >= 1) && diff >= 1e-15) {
		const digits = Math.ceil(Math.abs(Math.log10(diff)));
		const logicalOffset = LWC_LOG_LOGICAL_OFFSET + digits;

		return {
			logicalOffset,
			coordOffset: 1 / (10 ** logicalOffset),
		};
	}

	return { ...DEFAULT_LWC_LOG_FORMULA };
};

const toLightweightChartsLogPrice = (price, formula) => {
	const value = Number(price);

	if (!Number.isFinite(value)) return null;

	const magnitude = Math.abs(value);

	if (magnitude < 1e-15) return 0;

	const logged = Math.log10(magnitude + formula.coordOffset) + formula.logicalOffset;

	return value < 0 ? -logged : logged;
};

const fromLightweightChartsLogPrice = (logical, formula) => {
	const value = Number(logical);

	if (!Number.isFinite(value)) return null;

	const magnitude = Math.abs(value);

	if (magnitude < 1e-15) return 0;

	const price = (10 ** (magnitude - formula.logicalOffset)) - formula.coordOffset;

	return value < 0 ? -price : price;
};

const setPriceScaleLinearVisibleRange = (priceScale, min, max, isLog, formula) => {
	if (!priceScale || !(max > min)) return false;

	// Do not touch scaleMargins here — zeroing them remaps Y and moves the
	// price under the cursor on the first wheel tick.
	priceScale.applyOptions({ autoScale: false });

	if (!isLog) {
		priceScale.setVisibleRange({ from: min, to: max });
		return true;
	}

	if (!(min > 0) || !(max > 0) || !formula) return false;

	const from = toLightweightChartsLogPrice(min, formula);
	const to = toLightweightChartsLogPrice(max, formula);

	if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) return false;

	priceScale.setVisibleRange({ from, to });
	return true;
};

class Home extends React.Component {
	container = React.createRef();
	chartRef = React.createRef();
	orderTicketRef = React.createRef();
	indicatorTogglesRef = React.createRef();
	scaleControlsRef = React.createRef();
	chartBottomControlsRef = React.createRef();
	timeframeControlsRef = React.createRef();

	state = {
		candles: [],
		historicalCandles: [],
		currentCandle: null,
		depth: null,
		allOrders: [],
		orderStats: null,
		orderError: "",
		tdSequential: null,
		tdSequentialError: "",
		profile: null,
		profileError: "",
		isProfileLoading: false,
		balanceHistory: [],
		balanceHistoryPeriod: "week",
		balanceHistoryLoadedPeriod: "week",
		balanceHistoryLoading: false,
		balanceHistoryError: "",
		isProfileOpen: false,
		isOrdersOpen: false,
		isOrderTypeMenuOpen: false,
		closingDropdowns: {
			monitor: false,
			orders: false,
			profile: false,
		},
		isOrdersLoading: false,
		allOrdersError: "",
		monitorTickers: [],
		monitorError: "",
		defaultBaseCurrency: "",
		appBookmarks: null,
		appAvgEntries: null,
		appSettings: {
			balanceHistoryColored: true,
			balanceHistoryExpanded: false,
			balanceHistoryPeriod: "week",
		},
		isMonitorOpen: false,
		isMonitorFiltering: false,
		isCurrencyPickerHovered: false,
		isAccountRefreshing: false,
		isBalanceRefreshing: false,
		error: "",
		isLive: false,
		isLoading: true,
		isLoadingOlderCandles: false,
		hasMoreOlderCandles: true,
		isLogPriceScale: getCookieBoolean(PRICE_SCALE_COOKIES.logarithmic, false),
		isInvertedPriceScale: getCookieBoolean(PRICE_SCALE_COOKIES.inverted, false),
		showHud: getCookieBoolean(HUD_COOKIE, true),
		showDepthIndicator: getCookieBoolean(INDICATOR_COOKIES.depth, true),
		showTdIndicator: getCookieBoolean(INDICATOR_COOKIES.td, true),
		showVwapIndicator: getCookieBoolean(INDICATOR_COOKIES.vwap, true),
		showVolhIndicator: getCookieBoolean(
			INDICATOR_COOKIES.volh,
			getCookieBoolean(INDICATOR_COOKIES.histogram, true),
		),
		showPrchIndicator: getCookieBoolean(
			INDICATOR_COOKIES.prch,
			getCookieBoolean(INDICATOR_COOKIES.histogram, true),
		),
		showMacdIndicator: getCookieBoolean(
			INDICATOR_COOKIES.macd,
			getCookieBoolean(INDICATOR_COOKIES.r6, false),
		),
		showPvtIndicator: getCookieBoolean(
			INDICATOR_COOKIES.pvt,
			getCookieBoolean(
				"yztrade_indicator_obv",
				getCookieBoolean("yztrade_indicator_vol24", false),
			),
		),
		showLims24Indicator: getCookieBoolean(INDICATOR_COOKIES.lims24, false),
		showBagValueIndicator: getCookieBoolean(INDICATOR_COOKIES.bag, false),
		baseCurrency: getBaseCurrencyFromPath(window.location.pathname),
		monitorQuery: "",
		periodDays: getPeriodDaysForGranularity(getCandleGranularity()),
		periodGranularity: getCandleGranularity(),
		loadedPeriodDays: getPeriodDaysForGranularity(getCandleGranularity()),
		loadedPeriodGranularity: getCandleGranularity(),
		isCandleGranularityMenuOpen: false,
		isCandleGranularityMenuClosing: false,
		isBullseyeViewActive: false,
		chartNotice: null,
		product: null,
		productStats: null,
		chartSize: {
			width: 0,
			height: 0,
		},
		freeCrosshairX: null,
		pointerPosition: null,
		hoveredVolumeIndex: null,
		measurementStart: null,
		measurementEnd: null,
		measurementDrag: null,
		orderScaleHover: null,
		bookmarkedPrice: getBookmarkedPrice(getBaseCurrencyFromPath(window.location.pathname)),
		avgEntryPrice: null,
		orderTicket: null,
		isOrderTicketClosing: false,
		isOrderTicketPriceDragging: false,
		isOrderTicketMoveDragging: false,
		openOrderDrag: null,
		openOrderEditErrorFlashKey: "",
		lastOrderSide: "BUY",
		savedOrderTickets: {
			BUY: null,
			SELL: null,
		},
		overlayTick: 0,
		priceOverlayTick: 0,
	};

	chart = null;
	candleSeries = null;
	volumeSeries = null;
	tdSequentialSeries = null;
	vwapSeries = [];
	chartOrderDisplayByKey = new Map();
	orderLineDisplayPlace = "renderOverlay";
	cachedMacdPoints = [];
	cachedPvtPoints = [];
	cachedDistribution = null;
	cachedDistributionKey = null;
	liveVwapContext = null;
	overlayFrame = null;
	priceOverlayFrame = null;
	pointerMoveFrame = null;
	pendingPointerMove = null;
	priceScaleWheelFrame = null;
	priceScaleMinMoveSyncFrame = null;
	priceScaleWheelState = null;
	lastPriceViewportRange = null;
	lastPriceScaleMinMove = null;
	priceScaleWheelOverlayTimer = null;
	priceAxisPanPointer = null;
	chartPanPointer = null;
	cachedMacdOverlayModel = null;
	cachedMacdOverlayKey = null;
	visibleRangeHandler = null;
	// !IMPORTANT DO NOT TOUCH. DO NOT OPTIMIZE UNLESS REQUESTED BY USER.
	// Cold-start log: chart stays Normal until range event, then enter Log.
	pendingLogPriceScaleResync = false;
	isCrosshairTimeLabelVisible = false;
	liveSocket = null;
	liveProductId = null;
	liveTradesAfterAtMs = null;
	liveReconnectTimer = null;
	liveReconnectAttempt = 0;
	liveReconnectConfig = null;
	pinnedMarketDepthRange = null;
	liveConnectTimeout = null;
	liveWatchdogTimer = null;
	lastLiveMessageAt = 0;
	liveFlushTimer = null;
	pendingLiveTrades = [];
	pendingLiveDepth = null;
	appStateSocket = null;
	appStateReconnectTimer = null;
	appStateReconnectAttempt = 0;
	appStateWatchdogTimer = null;
	lastAppStateMessageAt = 0;
	isDisconnectingAppState = false;
	profileRefreshTimer = null;
	allOrdersRefreshTimer = null;
	balanceHistoryRefreshTimer = null;
	balanceHistoryRequestId = 0;
	monitorRefreshTimer = null;
	productStatsRefreshTimer = null;
	olderCandlesLoadTimer = null;
	olderCandlesApplyTimer = null;
	olderCandlesLoadInFlight = false;
	pendingOlderCandlesTargetFrom = null;
	lastVisibleRangeChangeAt = 0;
	isApplyingOlderCandles = false;
	tdRefreshTimers = [];
	lastTdRefreshBoundary = null;
	tdRefreshInFlight = false;
	marketRequestId = 0;
	officialCandlePollTimer = null;
	officialCandlePollRequestId = 0;
	officialCandlePollInFlight = false;
	lastOfficialCandleSyncAt = 0;
	isMarketTransitioning = false;
	isDisconnectingLive = false;
	suppressMeasurementClick = false;
	profileLoadPromises = new Map();
	latestBalanceGeneration = 0;
	pendingPartialFillBalanceGeneration = 0;
	partialFillBalanceRefreshTimer = null;
	processedOrderEventIds = new Set();
	processedOrderEventIdQueue = [];
	chartNoticeDebounceTimer = null;
	chartNoticeHideTimer = null;
	chartNoticeCloseTimer = null;
	isApplyingBullseyeFrame = false;
	bullseyeFrameRaf = null;
	bullseyePanPointerActive = false;
	bullseyePriceRange = null;
	manualPriceRange = null;
	// Frozen only while wheel-zooming in LOG — matches LWC; cleared on AUTO.
	priceScaleLogZoomFormula = null;
	candleGranularityMenuCloseTimer = null;
	dropdownCloseTimers = {};
	orderTicketCloseTimer = null;
	orderPreviewTimer = null;
	orderPreviewWaitTimer = null;
	orderPreviewRequestId = 0;
	marketPreviewPollTimer = null;
	lastMarketPreviewAt = 0;
	marketPreviewRequestPrice = null;
	overlayTextMeasureContext = null;
	overlayTextWidthCache = new Map();
	plottedCandles = [];
	lastLiveCandleBucketTime = null;
	marketSubscribeCount = 0;
	candleBackfillRequestId = 0;
	isOrderTicketPriceDragging = false;
	orderTicketPriceDragField = null;
	orderTicketPriceDragStartPrice = null;
	orderTicketPriceDragGrabOffsetY = 0;
	isOrderTicketMoveDragging = false;
	orderTicketMoveDrag = null;
	isOpenOrderPriceDragging = false;
	openOrderPriceDragGrabOffsetY = 0;
	openOrderDragPointerId = null;
	openOrderDragCaptureEl = null;
	openOrderEditErrorFlashTimer = null;
	allOrdersRequest = null;
	lastOrdersSocketMergeAt = 0;
	avgEntryRequestId = 0;
	avgEntryRefreshTimer = null;
	avgEntryRetryTimer = null;
	avgEntryRetryAttempt = 0;

	componentDidMount() {
		window.addEventListener('resize', this.handleResize);
		window.addEventListener('keydown', this.handleKeyDown);
		window.addEventListener('pointermove', this.handleMeasurementDragMove);
		window.addEventListener('pointerup', this.handleMeasurementDragEnd);
		window.addEventListener('pointermove', this.handleOrderTicketPriceDragMove);
		window.addEventListener('pointerup', this.handleOrderTicketPriceDragEnd);
		window.addEventListener('pointermove', this.handleOrderTicketMoveDragMove);
		window.addEventListener('pointerup', this.handleOrderTicketMoveDragEnd);
		document.addEventListener('pointerdown', this.handleDocumentPointerDown);
		this.initChart();
		this.loadAppState();
		this.connectAppStateSocket();
		this.bootstrapFromConfig();
		this.loadBalanceHistory();
		this.profileRefreshTimer = window.setInterval(this.loadProfile, PROFILE_REFRESH_INTERVAL_MS);
		this.restartAllOrdersRefreshTimer();
		this.avgEntryRefreshTimer = window.setInterval(
			() => this.loadAvgEntry(),
			AVG_ENTRY_REFRESH_INTERVAL_MS,
		);
		this.balanceHistoryRefreshTimer = window.setInterval(this.loadBalanceHistory, 30000);
		this.monitorRefreshTimer = window.setInterval(this.loadMonitorTickers, 60000);
		this.productStatsRefreshTimer = window.setInterval(this.loadProductStats, 30000);
	}

	bootstrapFromConfig = () => {
		const pathCurrency = getBaseCurrencyFromPath(this.props.history.pathname);

		api.getMonitorConfig().then(response => {
			const tickers = Array.isArray(response.data?.tickers) ? response.data.tickers : [];
			const defaultBaseCurrency = String(
				response.data?.default_base_currency || tickers[0] || "",
			).trim().toUpperCase();
			const baseCurrency = pathCurrency || defaultBaseCurrency;
			const monitorTickers = tickers.map(currency => ({
				currency: String(currency).trim().toUpperCase(),
				change_24h: null,
			}));

			this.setState({
				defaultBaseCurrency,
				monitorTickers,
				baseCurrency,
			}, () => {
				this.loadMarket();
				this.loadProfile();
				this.loadAllOrders();
				this.loadMonitorTickers();
			});
		}).catch(error => {
			if (pathCurrency) {
				this.setState({ baseCurrency: pathCurrency }, () => {
					this.loadMarket();
					this.loadProfile();
					this.loadAllOrders();
					this.loadMonitorTickers();
				});
				return;
			}

			this.setState({
				monitorError: error.response?.data?.detail || error.message || "Unable to load monitor config.",
				error: "Unable to load monitor config.",
				isLoading: false,
			});
		});
	};

	componentDidUpdate(prevProps, prevState) {
		if (
			prevState.candles !== this.state.candles
			|| prevState.baseCurrency !== this.state.baseCurrency
			|| prevState.product !== this.state.product
		) {
			this.updateDocumentTitle();
		}

		if (
			prevState.showDepthIndicator !== this.state.showDepthIndicator
			|| prevState.showTdIndicator !== this.state.showTdIndicator
			|| prevState.showVwapIndicator !== this.state.showVwapIndicator
			|| prevState.showVolhIndicator !== this.state.showVolhIndicator
			|| prevState.showPrchIndicator !== this.state.showPrchIndicator
			|| prevState.showMacdIndicator !== this.state.showMacdIndicator
			|| prevState.showPvtIndicator !== this.state.showPvtIndicator
			|| prevState.showLims24Indicator !== this.state.showLims24Indicator
			|| prevState.showBagValueIndicator !== this.state.showBagValueIndicator
		) {
			this.applyIndicatorVisibility();
		}

		if (prevProps.history.pathname === this.props.history.pathname) {
			const prevTicket = prevState.orderTicket;
			const nextTicket = this.state.orderTicket;
			const hadMarketPreviewPoller = Boolean(prevTicket && this.isMarketOrderTicket(prevTicket));
			const hasMarketPreviewPoller = Boolean(nextTicket && this.isMarketOrderTicket(nextTicket));

			if (hadMarketPreviewPoller !== hasMarketPreviewPoller) {
				this.syncMarketPreviewPoller();
			}

			if (nextTicket && prevState.profile !== this.state.profile && !this.state.isOrderTicketClosing) {
				this.syncOrderTicketOnBalanceChange(prevState);
			}

			if (
				prevState.profile !== this.state.profile
				|| prevState.candles !== this.state.candles
				|| prevState.appAvgEntries !== this.state.appAvgEntries
			) {
				this.syncAvgEntryPriceForDisplay();
			}

			return;
		}

		const baseCurrency = getBaseCurrencyFromPath(
			this.props.history.pathname,
			this.state.defaultBaseCurrency,
		);

		if (baseCurrency === this.state.baseCurrency) return;

		this.setState({
			baseCurrency,
			isMonitorFiltering: false,
			monitorQuery: "",
		}, () => {
			this.loadMarket();
			this.loadProfile();
			this.loadAllOrders();
		});
	}

	updateDocumentTitle = () => {
		const lastCandle = this.state.candles[this.state.candles.length - 1];
		const price = Number(lastCandle?.close);
		const currency = this.state.baseCurrency;

		document.title = Number.isFinite(price)
			? `${formatPriceWithIncrement(price, this.state.product?.quote_increment)} ${currency}`
			: `${currency} Trade`;
	};

	componentWillUnmount() {
		window.removeEventListener('resize', this.handleResize);
		window.removeEventListener('keydown', this.handleKeyDown);
		window.removeEventListener('pointermove', this.handleMeasurementDragMove);
		window.removeEventListener('pointerup', this.handleMeasurementDragEnd);
		window.removeEventListener('pointermove', this.handleOrderTicketPriceDragMove);
		window.removeEventListener('pointerup', this.handleOrderTicketPriceDragEnd);
		window.removeEventListener('pointermove', this.handleOrderTicketMoveDragMove);
		window.removeEventListener('pointerup', this.handleOrderTicketMoveDragEnd);
		document.removeEventListener('pointerdown', this.handleDocumentPointerDown);
		this.removeChartInteractionListeners();
		this.disconnectLiveMarket();
		this.disconnectAppStateSocket();

		this.profileLoadPromises.clear();

		if (this.partialFillBalanceRefreshTimer) {
			window.clearTimeout(this.partialFillBalanceRefreshTimer);
			this.partialFillBalanceRefreshTimer = null;
		}

		if (
			this.visibleRangeHandler
			&& this.chart
			&& this.chart.timeScale().unsubscribeVisibleLogicalRangeChange
		) {
			this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.visibleRangeHandler);
		}

		if (this.overlayFrame) {
			cancelAnimationFrame(this.overlayFrame);
		}

		if (this.priceOverlayFrame) {
			cancelAnimationFrame(this.priceOverlayFrame);
		}

		if (this.pointerMoveFrame) {
			cancelAnimationFrame(this.pointerMoveFrame);
		}

		if (this.priceScaleWheelFrame) {
			cancelAnimationFrame(this.priceScaleWheelFrame);
		}

		if (this.priceScaleMinMoveSyncFrame) {
			cancelAnimationFrame(this.priceScaleMinMoveSyncFrame);
		}

		if (this.priceScaleWheelOverlayTimer) {
			window.clearTimeout(this.priceScaleWheelOverlayTimer);
		}

		if (this.profileRefreshTimer) {
			window.clearInterval(this.profileRefreshTimer);
		}

		if (this.allOrdersRefreshTimer) {
			window.clearInterval(this.allOrdersRefreshTimer);
		}

		if (this.avgEntryRefreshTimer) {
			window.clearInterval(this.avgEntryRefreshTimer);
			this.avgEntryRefreshTimer = null;
		}

		this.clearAvgEntryRetry();

		if (this.openOrderEditErrorFlashTimer) {
			window.clearTimeout(this.openOrderEditErrorFlashTimer);
			this.openOrderEditErrorFlashTimer = null;
		}

		if (this.balanceHistoryRefreshTimer) {
			window.clearInterval(this.balanceHistoryRefreshTimer);
		}

		if (this.monitorRefreshTimer) {
			window.clearInterval(this.monitorRefreshTimer);
		}

		if (this.olderCandlesLoadTimer) {
			window.clearTimeout(this.olderCandlesLoadTimer);
		}

		if (this.olderCandlesApplyTimer) {
			window.clearTimeout(this.olderCandlesApplyTimer);
		}

		if (this.productStatsRefreshTimer) {
			window.clearInterval(this.productStatsRefreshTimer);
		}

		this.clearLiveFlushTimer();
		this.stopOfficialCandlePoll();

		if (this.candleGranularityMenuCloseTimer) {
			window.clearTimeout(this.candleGranularityMenuCloseTimer);
		}

		Object.values(this.dropdownCloseTimers).forEach(timer => window.clearTimeout(timer));
		if (this.orderTicketCloseTimer) {
			window.clearTimeout(this.orderTicketCloseTimer);
		}

		if (this.chartNoticeDebounceTimer) {
			window.clearTimeout(this.chartNoticeDebounceTimer);
			this.chartNoticeDebounceTimer = null;
		}

		if (this.chartNoticeHideTimer) {
			window.clearTimeout(this.chartNoticeHideTimer);
			this.chartNoticeHideTimer = null;
		}

		if (this.chartNoticeCloseTimer) {
			window.clearTimeout(this.chartNoticeCloseTimer);
			this.chartNoticeCloseTimer = null;
		}

		if (this.orderPreviewTimer) {
			window.clearTimeout(this.orderPreviewTimer);
		}

		this.stopOrderPreviewWaitTicker();
		this.stopMarketPreviewPoller();

		this.clearTdRefreshTimers();

		if (this.chart) {
			this.chart.remove();
		}
	}

	scheduleOverlayUpdate = () => {
		if (this.overlayFrame) return;

		this.overlayFrame = requestAnimationFrame(() => {
			this.overlayFrame = null;
			// Full overlay refresh (time/data changes) — invalidates MACD/PVT cache.
			this.cachedMacdOverlayKey = null;
			this.setState(prev => ({
				overlayTick: prev.overlayTick + 1,
			}));
		});
	};

	// Price-axis Y changes only: refresh priceToY overlays, leave MACD/PVT cached.
	schedulePriceOverlayUpdate = () => {
		if (this.priceOverlayFrame) return;

		this.priceOverlayFrame = requestAnimationFrame(() => {
			this.priceOverlayFrame = null;
			this.setState(prev => ({
				priceOverlayTick: prev.priceOverlayTick + 1,
			}));
		});
	};

	getDropdownOpenStateKey = (name) => {
		switch (name) {
			case "monitor":
				return "isMonitorOpen";
			case "orders":
				return "isOrdersOpen";
			case "profile":
				return "isProfileOpen";
			default:
				return "";
		}
	};

	clearDropdownCloseTimer = (name) => {
		if (!this.dropdownCloseTimers[name]) return;

		window.clearTimeout(this.dropdownCloseTimers[name]);
		delete this.dropdownCloseTimers[name];
	};

	scheduleDropdownCloseEnd = (name) => {
		this.clearDropdownCloseTimer(name);

		this.dropdownCloseTimers[name] = window.setTimeout(() => {
			delete this.dropdownCloseTimers[name];
			this.setState(prev => ({
				closingDropdowns: {
					...prev.closingDropdowns,
					[name]: false,
				},
			}));
		}, DROPDOWN_TRANSITION_MS);
	};

	setAnimatedDropdown = (name, isOpen, options = {}) => {
		const openKey = this.getDropdownOpenStateKey(name);
		if (!openKey) return;

		const closeNames = Array.isArray(options.close) ? options.close : [];
		const closingNames = isOpen ? closeNames : [name];

		if (isOpen) this.clearDropdownCloseTimer(name);
		closeNames.forEach(closeName => this.clearDropdownCloseTimer(closeName));

		this.setState(prev => {
			const closingDropdowns = { ...prev.closingDropdowns };
			const nextState = {
				...options.state,
				[openKey]: isOpen,
			};

			closingDropdowns[name] = false;

			closeNames.forEach(closeName => {
				const closeKey = this.getDropdownOpenStateKey(closeName);

				if (!closeKey) return;

				if (prev[closeKey] || prev.closingDropdowns[closeName]) {
					closingDropdowns[closeName] = true;
				}

				nextState[closeKey] = false;
			});

			if (!isOpen && (prev[openKey] || prev.closingDropdowns[name])) {
				closingDropdowns[name] = true;
			}

			return {
				...nextState,
				closingDropdowns,
			};
		}, () => {
			closingNames.forEach(closeName => {
				if (this.state.closingDropdowns[closeName]) {
					this.scheduleDropdownCloseEnd(closeName);
				}
			});

			if (isOpen && typeof options.onOpen === "function") {
				options.onOpen();
			}
		});
	};

	closeAnimatedDropdowns = (names) => {
		const closeNames = names.filter(name => this.getDropdownOpenStateKey(name));

		if (!closeNames.length) return;

		closeNames.forEach(name => this.clearDropdownCloseTimer(name));

		this.setState(prev => {
			const closingDropdowns = { ...prev.closingDropdowns };
			const nextState = {};
			let hasChanges = false;

			closeNames.forEach(name => {
				const openKey = this.getDropdownOpenStateKey(name);

				if (!openKey) return;

				nextState[openKey] = false;

				if (prev[openKey] || prev.closingDropdowns[name]) {
					closingDropdowns[name] = true;
					hasChanges = true;
				}
			});

			return hasChanges
				? { ...nextState, closingDropdowns }
				: null;
		}, () => {
			closeNames.forEach(name => {
				if (this.state.closingDropdowns[name]) {
					this.scheduleDropdownCloseEnd(name);
				}
			});
		});
	};

	handleDocumentPointerDown = (event) => {
		const target = event.target;
		const nextState = {};

		if (!(target instanceof Element)) return;

		if (this.state.isMonitorOpen && !target.closest(".e__currency-picker")) {
			nextState.monitor = true;
		}

		if (this.state.isOrdersOpen && !target.closest(".e__orders-menu-wrap")) {
			nextState.orders = true;
		}

		if (this.state.isProfileOpen && !target.closest(".e__profile-button, .e__profile-menu")) {
			nextState.profile = true;
		}

		if (this.state.isOrderTypeMenuOpen && !target.closest(".e__order-ticket__type-menu-wrap")) {
			nextState.isOrderTypeMenuOpen = false;
		}

		if (
			(this.state.isCandleGranularityMenuOpen || this.state.isCandleGranularityMenuClosing)
			&& !target.closest(".e__timeframe-controls")
		) {
			this.closeCandleGranularityMenu();
		}

		const dropdownsToClose = ["monitor", "orders", "profile"].filter(name => nextState[name]);

		if (dropdownsToClose.length) {
			this.closeAnimatedDropdowns(dropdownsToClose);
		}

		const localStatePatch = {};

		if (nextState.isOrderTypeMenuOpen === false) {
			localStatePatch.isOrderTypeMenuOpen = false;
		}

		if (Object.keys(localStatePatch).length) {
			this.setState(localStatePatch);
		}
	};

	handleVisibleLogicalRangeChange = (range) => {
		// !IMPORTANT DO NOT TOUCH. DO NOT OPTIMIZE UNLESS REQUESTED BY USER.
		this.applyPendingLogPriceScaleResync();
		this.scheduleOverlayUpdate();
		this.lastVisibleRangeChangeAt = performance.now();

		if (range && Number.isFinite(range.from) && range.from > 24) {
			this.pendingOlderCandlesTargetFrom = null;
			if (this.olderCandlesLoadTimer) {
				window.clearTimeout(this.olderCandlesLoadTimer);
				this.olderCandlesLoadTimer = null;
			}
		}

		if (this.state.isBullseyeViewActive) {
			if (
				!this.isApplyingBullseyeFrame
				&& range
				&& Number.isFinite(range.from)
			) {
				this.frameChartTo24hFocus();
			}

			if (
				this.isApplyingOlderCandles
				|| !range
				|| !Number.isFinite(range.from)
				|| range.from > 24
			) {
				return;
			}

			this.scheduleOlderCandlesLoad(range.from);
			return;
		}

		if (
			this.isApplyingOlderCandles
			|| !range
			|| !Number.isFinite(range.from)
			|| range.from > 24
		) {
			return;
		}

		this.scheduleOlderCandlesLoad(range.from);
	};

	getChartInteractionOptions = (locked = this.state.isBullseyeViewActive) => ({
		handleScroll: {
			mouseWheel: !locked,
			pressedMouseMove: !locked,
			horzTouchDrag: !locked,
			vertTouchDrag: !locked,
		},
		handleScale: {
			mouseWheel: !locked,
			pinch: !locked,
			axisPressedMouseMove: {
				time: !locked,
				price: !locked,
			},
			axisDoubleClickReset: {
				time: !locked,
				price: !locked,
			},
		},
	});

	applyChartInteractionLock = (locked = this.state.isBullseyeViewActive) => {
		this.chart?.applyOptions({
			...this.getChartInteractionOptions(locked),
			timeScale: {
				shiftVisibleRangeOnNewBar: !locked,
			},
		});
	};

	showChartNotice = (message, options = {}) => {
		const text = String(message || "").trim();
		if (!text) return;

		const tone = options.tone || "info";
		const debounceMs = Number.isFinite(Number(options.debounceMs))
			? Math.max(0, Number(options.debounceMs))
			: 0;
		const durationMs = Number.isFinite(Number(options.durationMs))
			? Math.max(0, Number(options.durationMs))
			: CHART_NOTICE_DURATION_MS;

		if (this.chartNoticeDebounceTimer) {
			window.clearTimeout(this.chartNoticeDebounceTimer);
			this.chartNoticeDebounceTimer = null;
		}

		const reveal = () => {
			this.chartNoticeDebounceTimer = null;

			if (this.chartNoticeCloseTimer) {
				window.clearTimeout(this.chartNoticeCloseTimer);
				this.chartNoticeCloseTimer = null;
			}

			this.setState({
				chartNotice: {
					message: text,
					tone,
					closing: false,
				},
			});

			if (this.chartNoticeHideTimer) {
				window.clearTimeout(this.chartNoticeHideTimer);
			}

			this.chartNoticeHideTimer = window.setTimeout(() => {
				this.chartNoticeHideTimer = null;
				this.closeChartNotice();
			}, durationMs);
		};

		if (debounceMs > 0) {
			this.chartNoticeDebounceTimer = window.setTimeout(reveal, debounceMs);
			return;
		}

		reveal();
	};

	notifyBullseyeInteractionLocked = () => {
		if (!this.state.isBullseyeViewActive) return;

		this.showChartNotice("Pan and zoom disabled in Bullseye view", {
			debounceMs: BULLSEYE_LOCK_NOTICE_DEBOUNCE_MS,
		});
	};

	closeChartNotice = () => {
		const notice = this.state.chartNotice;
		if (!notice || notice.closing) {
			return;
		}

		this.setState({
			chartNotice: {
				...notice,
				closing: true,
			},
		});

		if (this.chartNoticeCloseTimer) {
			window.clearTimeout(this.chartNoticeCloseTimer);
		}

		this.chartNoticeCloseTimer = window.setTimeout(() => {
			this.chartNoticeCloseTimer = null;
			this.setState({ chartNotice: null });
		}, DROPDOWN_TRANSITION_MS);
	};

	handleBullseyeLockPointerDown = (event) => {
		if (!this.state.isBullseyeViewActive || event.button !== 0) return;
		this.bullseyePanPointerActive = true;
	};

	handleBullseyeLockPointerUp = () => {
		this.bullseyePanPointerActive = false;
	};

	handleBullseyeLockPointerMove = (event) => {
		if (
			!this.state.isBullseyeViewActive
			|| !this.bullseyePanPointerActive
			|| (event.buttons & 1) !== 1
		) {
			return;
		}

		if (
			this.isOrderTicketPriceDragging
			|| this.isOrderTicketMoveDragging
			|| this.state.measurementStart
		) {
			return;
		}

		this.notifyBullseyeInteractionLocked();
	};

	handleBullseyeLockWheel = (event) => {
		if (!this.state.isBullseyeViewActive) return;

		event.preventDefault();
		this.notifyBullseyeInteractionLocked();
	};

	addChartInteractionListeners = () => {
		const el = this.chartRef.current;
		if (!el) return;

		this.chartInteractionEvents = [
			"pointerdown",
			"pointerup",
			"pointerleave",
			"touchmove",
		];

		this.chartInteractionEvents.forEach(eventName => {
			el.addEventListener(eventName, this.scheduleOverlayUpdate, { passive: true });
		});

		el.addEventListener("pointerleave", this.handleFreeCrosshairLeave, { passive: true });
		el.addEventListener("mouseleave", this.handleFreeCrosshairLeave, { passive: true });
		el.addEventListener("wheel", this.handlePriceScaleWheel, { passive: false, capture: true });
		el.addEventListener("wheel", this.handleBullseyeLockWheel, { passive: false, capture: true });
		el.addEventListener("pointerdown", this.handlePriceAxisPanPointerDown, { passive: true });
		el.addEventListener("pointerdown", this.handleBullseyeLockPointerDown, { passive: true });
		el.addEventListener("pointermove", this.handleBullseyeLockPointerMove, { passive: true });
		el.addEventListener("pointerup", this.handlePriceAxisPanPointerUp, { passive: true });
		el.addEventListener("pointercancel", this.handlePriceAxisPanPointerUp, { passive: true });
		el.addEventListener("pointerup", this.handleBullseyeLockPointerUp, { passive: true });
		el.addEventListener("pointercancel", this.handleBullseyeLockPointerUp, { passive: true });
		el.addEventListener("pointerleave", this.handleBullseyeLockPointerUp, { passive: true });
		el.addEventListener("click", this.handleMeasurementClick);
		window.addEventListener("pointerup", this.handlePriceAxisPanPointerUp);
		window.addEventListener("pointercancel", this.handlePriceAxisPanPointerUp);
	};

	removeChartInteractionListeners = () => {
		const el = this.chartRef.current;
		if (!el || !this.chartInteractionEvents) return;

		this.chartInteractionEvents.forEach(eventName => {
			el.removeEventListener(eventName, this.scheduleOverlayUpdate);
		});

		el.removeEventListener("pointerleave", this.handleFreeCrosshairLeave);
		el.removeEventListener("mouseleave", this.handleFreeCrosshairLeave);
		el.removeEventListener("wheel", this.handlePriceScaleWheel, true);
		el.removeEventListener("wheel", this.handleBullseyeLockWheel, true);
		el.removeEventListener("pointerdown", this.handlePriceAxisPanPointerDown);
		el.removeEventListener("pointerdown", this.handleBullseyeLockPointerDown);
		el.removeEventListener("pointermove", this.handleBullseyeLockPointerMove);
		el.removeEventListener("pointerup", this.handlePriceAxisPanPointerUp);
		el.removeEventListener("pointercancel", this.handlePriceAxisPanPointerUp);
		el.removeEventListener("pointerup", this.handleBullseyeLockPointerUp);
		el.removeEventListener("pointercancel", this.handleBullseyeLockPointerUp);
		el.removeEventListener("pointerleave", this.handleBullseyeLockPointerUp);
		el.removeEventListener("click", this.handleMeasurementClick);
		window.removeEventListener("pointerup", this.handlePriceAxisPanPointerUp);
		window.removeEventListener("pointercancel", this.handlePriceAxisPanPointerUp);
		this.priceAxisPanPointer = null;
		this.chartPanPointer = null;
	};

	handleKeyDown = (event) => {
		if (event.key !== "Escape") return;

		if (this.isOpenOrderPriceDragging || this.state.openOrderDrag) {
			event.preventDefault();
			this.cancelOpenOrderPriceDrag();
			return;
		}

		if (this.isOrderTicketPriceDragging) {
			event.preventDefault();
			this.cancelOrderTicketPriceDrag();
			return;
		}

		if (this.state.isCandleGranularityMenuOpen || this.state.isCandleGranularityMenuClosing) {
			this.closeCandleGranularityMenu();
			return;
		}

		// In-progress only (1st point set, awaiting 2nd). Locked measurements clear via × only.
		const measurementInProgress = Boolean(
			this.state.measurementStart && !this.state.measurementEnd,
		);

		if (measurementInProgress) {
			this.clearMeasurement();
			return;
		}

		if (this.state.orderTicket && !this.state.isOrderTicketClosing) {
			this.closeOrderTicket();
		}
	};

	clearMeasurement = () => {
		this.measurementMoveOrigin = null;
		this.measurementMoveSnapshot = null;
		this.setState({
			measurementStart: null,
			measurementEnd: null,
			measurementDrag: null,
		});
	};

	handleMeasurementClear = (event) => {
		event?.preventDefault?.();
		event?.stopPropagation?.();
		this.clearMeasurement();
	};

	getMeasurementPointFromCoordinates = (x, y) => {
		if (!this.chart || !this.candleSeries) return null;

		const price = this.candleSeries.coordinateToPrice(y);
		if (!Number.isFinite(price)) return null;

		const time = this.measurementXToTime(x);

		if (!Number.isFinite(time)) return null;

		return {
			price,
			time,
		};
	};

	getMeasurementPointFromEvent = (event) => {
		const el = this.chartRef.current;
		if (!el) return null;

		const rect = el.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;

		if (x < 0 || x > rect.width || y < 0 || y > rect.height) return null;

		return this.getMeasurementPointFromCoordinates(x, y);
	};

	handleMeasurementClick = (event) => {
		if (this.handleCtrlChartOrderClick(event)) {
			event.preventDefault();
			return;
		}

		if (this.handleOrderPlusChartClick(event)) {
			event.preventDefault();
			return;
		}

		if (this.suppressMeasurementClick) {
			this.suppressMeasurementClick = false;
			event.preventDefault();
			return;
		}

		const point = this.getMeasurementPointFromEvent(event);
		if (!point) return;

		if (event.shiftKey) {
			event.preventDefault();
			this.setState({
				measurementStart: point,
				measurementEnd: null,
				measurementDrag: null,
			});
			return;
		}

		if (this.state.measurementStart && !this.state.measurementEnd) {
			event.preventDefault();
			this.setState({ measurementEnd: point });
		}
	};

	handleOrderPlusChartClick = (event) => {
		const hover = this.state.orderScaleHover;
		const el = this.chartRef.current;

		if (!hover || !el) return false;

		const rect = el.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		const localX = x - hover.x;
		const localY = y - hover.y;

		if (Math.abs(localX) > 33 || Math.abs(localY) > 18) return false;

		if (localX < 0) {
			this.bookmarkOrderHoverPrice(event);
		} else {
			this.applyOrderHoverPrice(event);
		}

		return true;
	};

	handleCtrlChartOrderClick = (event) => {
		if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.button !== 0) {
			return false;
		}

		const target = event.target;
		if (target?.closest?.("input, textarea, select, [contenteditable='true']")) {
			return false;
		}

		const el = this.chartRef.current;
		if (!el || !this.candleSeries) return false;
		if (this.state.isOrderTicketClosing || this.orderTicketCloseTimer) return false;

		const rect = el.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;

		if (x < 0 || x > rect.width || y < 0 || y > rect.height) return false;

		const price = this.candleSeries.coordinateToPrice(y);

		if (!Number.isFinite(price) || price <= 0) return false;

		event.preventDefault();
		event.stopPropagation();

		const priceValue = this.getOrderPriceInputValue(price);
		const ticket = this.state.orderTicket;

		if (!ticket) {
			const side = this.getDefaultOrderSideForPrice(price);

			this.setState(prev => ({
				savedOrderTickets: this.clearSavedOrderTicketAmounts(prev.savedOrderTickets),
				orderTicket: {
					...this.getOrderTicketDefaults(price, side),
					anchorPrice: price,
					anchorY: y,
				},
				isOrderTicketClosing: false,
				lastOrderSide: side,
			}), () => {
				this.refreshBalancesManually("order_overlay_open");
				this.scheduleOrderPreview();
			});

			return true;
		}

		if (this.isSellTrailingOrderTicket(ticket)) {
			return true;
		}

		if (this.isMarketOrderTicket(ticket)) {
			this.cancelOrderPreviewRequests();

			const nextTicket = {
				...ticket,
				orderType: "LIMIT",
				price: priceValue,
				activePriceField: "price",
			};

			this.updateOrderTicket({
				...this.getOrderPreviewResetPatch(),
				orderType: "LIMIT",
				price: priceValue,
				activePriceField: "price",
				fraction: this.getOrderFractionFromAmount(nextTicket),
			}, {
				onCommitted: () => {
					this.stopMarketPreviewPoller();
				},
			});

			return true;
		}

		const nextTicket = {
			...ticket,
			price: priceValue,
			activePriceField: "price",
		};

		this.updateOrderTicket({
			price: priceValue,
			activePriceField: "price",
			fraction: this.getOrderFractionFromAmount(nextTicket),
		});

		return true;
	};

	handleMeasurementDragStart = (endpoint, event) => {
		event.preventDefault();
		event.stopPropagation();

		this.suppressMeasurementClick = true;
		this.measurementMoveOrigin = null;
		this.measurementMoveSnapshot = null;
		this.setState({ measurementDrag: endpoint });
	};

	handleMeasurementMoveDragStart = (event) => {
		if (event.button != null && event.button !== 0) return;
		if (!this.state.measurementStart || !this.state.measurementEnd) return;

		const el = this.chartRef.current;
		if (!el || !this.chart || !this.candleSeries) return;

		event.preventDefault();
		event.stopPropagation();

		const rect = el.getBoundingClientRect();
		const startX = this.measurementTimeToX(this.state.measurementStart.time);
		const startY = this.priceToY(this.state.measurementStart.price);
		const endX = this.measurementTimeToX(this.state.measurementEnd.time);
		const endY = this.priceToY(this.state.measurementEnd.price);

		if (
			!Number.isFinite(startX)
			|| !Number.isFinite(startY)
			|| !Number.isFinite(endX)
			|| !Number.isFinite(endY)
		) {
			return;
		}

		this.suppressMeasurementClick = true;
		this.measurementMoveOrigin = {
			clientX: event.clientX,
			clientY: event.clientY,
			rectLeft: rect.left,
			rectTop: rect.top,
		};
		this.measurementMoveSnapshot = {
			startX,
			startY,
			endX,
			endY,
		};
		this.setState({ measurementDrag: "move" });
	};

	handleMeasurementDragMove = (event) => {
		const { measurementDrag } = this.state;
		if (!measurementDrag) return;

		if (measurementDrag === "move") {
			const origin = this.measurementMoveOrigin;
			const snapshot = this.measurementMoveSnapshot;

			if (!origin || !snapshot) return;

			const dx = event.clientX - origin.clientX;
			const dy = event.clientY - origin.clientY;
			const nextStart = this.getMeasurementPointFromCoordinates(
				snapshot.startX + dx,
				snapshot.startY + dy,
			);
			const nextEnd = this.getMeasurementPointFromCoordinates(
				snapshot.endX + dx,
				snapshot.endY + dy,
			);

			if (!nextStart || !nextEnd) return;

			this.setState({
				measurementStart: nextStart,
				measurementEnd: nextEnd,
			});
			return;
		}

		const point = this.getMeasurementPointFromEvent(event);
		if (!point) return;

		this.setState({
			[measurementDrag === "start" ? "measurementStart" : "measurementEnd"]: point,
		});
	};

	handleMeasurementDragEnd = () => {
		if (!this.state.measurementDrag) return;

		this.measurementMoveOrigin = null;
		this.measurementMoveSnapshot = null;
		this.setState({ measurementDrag: null });
		window.setTimeout(() => {
			this.suppressMeasurementClick = false;
		}, 0);
	};

	isPointerOverPriceScale = (event) => {
		if (!this.chart) return false;

		const el = this.chartRef.current;
		if (!el) return false;

		const rect = el.getBoundingClientRect();
		const priceScaleWidth = Math.max(this.chart.priceScale("right")?.width?.() || 0, 76);
		const x = event.clientX - rect.left;

		return x >= rect.width - priceScaleWidth && x <= rect.width;
	};

	handlePriceAxisPanPointerDown = (event) => {
		if (event.button != null && event.button !== 0) return;

		this.chartPanPointer = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
		};

		if (!this.isPointerOverPriceScale(event)) return;

		this.priceAxisPanPointer = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
		};
	};

	handlePriceAxisPanPointerUp = (event) => {
		const chartStart = this.chartPanPointer;
		const axisStart = this.priceAxisPanPointer;

		if (
			chartStart
			&& (event.pointerId == null || chartStart.pointerId === event.pointerId)
		) {
			this.chartPanPointer = null;
		}

		if (!axisStart) return;
		if (event.pointerId != null && axisStart.pointerId !== event.pointerId) return;

		this.priceAxisPanPointer = null;
	};

	handlePriceScaleWheel = (event) => {
		if (!this.chart || !this.candleSeries || event.deltaY === 0) return;

		const el = this.chartRef.current;
		if (!el) return;

		const rect = el.getBoundingClientRect();
		const priceScale = this.chart.priceScale('right');
		const priceScaleWidth = Math.max(priceScale.width?.() || 0, 76);
		const x = event.clientX - rect.left;

		if (x < rect.width - priceScaleWidth || x > rect.width) return;

		if (this.state.isBullseyeViewActive) {
			if (event.cancelable) event.preventDefault();
			event.stopPropagation();
			this.notifyBullseyeInteractionLocked();
			return;
		}

		if (event.cancelable) event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation?.();

		const y = event.clientY - rect.top;
		const deltaY = normalizePriceScaleWheelDeltaY(event);

		this.priceScaleWheelState = {
			y,
			normDeltaY: (this.priceScaleWheelState?.normDeltaY || 0) + deltaY,
		};

		if (this.priceScaleWheelFrame) return;

		this.priceScaleWheelFrame = requestAnimationFrame(() => {
			this.priceScaleWheelFrame = null;
			this.applyPriceScaleWheel();
		});
	};

	applyPriceScaleWheel = () => {
		if (!this.chart || !this.candleSeries || !this.priceScaleWheelState) return;

		const priceScale = this.getMainPriceScale();
		const el = this.chartRef.current;
		const { y, normDeltaY } = this.priceScaleWheelState;

		this.priceScaleWheelState = null;

		if (!priceScale || !el) return;

		const zoomFactor = priceScaleZoomFactorFromDelta(normDeltaY);

		if (zoomFactor == null || zoomFactor === 1) return;

		const paneHeight = Number(this.chart.paneSize?.(0)?.height);
		const height = Number.isFinite(paneHeight) && paneHeight > 2
			? paneHeight
			: Math.max(2, el.clientHeight - CHART_TIME_SCALE_HEIGHT);

		if (!(height > 2)) return;
		if (y < 0 || y > height) return;

		const isLog = Boolean(this.state.isLogPriceScale);
		const viewport = this.getPriceViewportRange();
		const vanishing = this.candleSeries.coordinateToPrice(y);

		if (!viewport || !Number.isFinite(vanishing)) {
			return;
		}

		const beforeMin = viewport.min;
		const beforeMax = viewport.max;

		this.manualPriceRange = null;

		let nextMin;
		let nextMax;
		let formula = null;

		if (isLog) {
			if (!(beforeMin > 0) || !(beforeMax > 0) || !(vanishing > 0)) return;

			if (!this.priceScaleLogZoomFormula) {
				this.priceScaleLogZoomFormula = getLightweightChartsLogFormula(beforeMin, beforeMax);
			}

			formula = this.priceScaleLogZoomFormula;

			const logFrom = toLightweightChartsLogPrice(beforeMin, formula);
			const logTo = toLightweightChartsLogPrice(beforeMax, formula);
			const logVanishing = toLightweightChartsLogPrice(vanishing, formula);

			if (
				!Number.isFinite(logFrom)
				|| !Number.isFinite(logTo)
				|| !Number.isFinite(logVanishing)
			) {
				return;
			}

			const newLogFrom = logVanishing + (logFrom - logVanishing) * zoomFactor;
			const newLogTo = logVanishing + (logTo - logVanishing) * zoomFactor;
			nextMin = fromLightweightChartsLogPrice(Math.min(newLogFrom, newLogTo), formula);
			nextMax = fromLightweightChartsLogPrice(Math.max(newLogFrom, newLogTo), formula);
		} else {
			const newFrom = vanishing + (beforeMin - vanishing) * zoomFactor;
			const newTo = vanishing + (beforeMax - vanishing) * zoomFactor;
			nextMin = Math.min(newFrom, newTo);
			nextMax = Math.max(newFrom, newTo);
		}

		if (
			!Number.isFinite(nextMin)
			|| !Number.isFinite(nextMax)
			|| !(nextMax > nextMin)
		) {
			return;
		}

		if (!setPriceScaleLinearVisibleRange(priceScale, nextMin, nextMax, isLog, formula)) {
			return;
		}

		// Pin vanishing price to the same Y — correct any apply/mapping drift.
		for (let pass = 0; pass < 3; pass += 1) {
			const yAfter = this.candleSeries.priceToCoordinate(vanishing);

			if (!Number.isFinite(yAfter) || Math.abs(yAfter - y) < 0.35) {
				break;
			}

			const priceAtCursor = this.candleSeries.coordinateToPrice(y);

			if (!Number.isFinite(priceAtCursor)) break;

			if (isLog) {
				if (!(priceAtCursor > 0) || !(vanishing > 0) || !formula) break;

				const logShift = toLightweightChartsLogPrice(vanishing, formula)
					- toLightweightChartsLogPrice(priceAtCursor, formula);

				if (!Number.isFinite(logShift)) break;

				const logMin = toLightweightChartsLogPrice(nextMin, formula) + logShift;
				const logMax = toLightweightChartsLogPrice(nextMax, formula) + logShift;

				nextMin = fromLightweightChartsLogPrice(Math.min(logMin, logMax), formula);
				nextMax = fromLightweightChartsLogPrice(Math.max(logMin, logMax), formula);
			} else {
				const shift = vanishing - priceAtCursor;
				nextMin += shift;
				nextMax += shift;
			}

			if (
				!Number.isFinite(nextMin)
				|| !Number.isFinite(nextMax)
				|| !(nextMax > nextMin)
			) {
				break;
			}

			if (!setPriceScaleLinearVisibleRange(priceScale, nextMin, nextMax, isLog, formula)) {
				break;
			}
		}

		this.lastPriceViewportRange = { min: nextMin, max: nextMax };

		// If formula mismatch ×10'd on first log tick, switch to span formula and retry once.
		if (
			isLog
			&& spanRatioSuspect(beforeMin, beforeMax, nextMin, nextMax)
			&& this.priceScaleLogZoomFormula?.logicalOffset === DEFAULT_LWC_LOG_FORMULA.logicalOffset
		) {
			this.priceScaleLogZoomFormula = getLightweightChartsLogFormula(beforeMin, beforeMax);
			formula = this.priceScaleLogZoomFormula;

			const logFrom = toLightweightChartsLogPrice(beforeMin, formula);
			const logTo = toLightweightChartsLogPrice(beforeMax, formula);
			const logVanishing = toLightweightChartsLogPrice(vanishing, formula);
			const newLogFrom = logVanishing + (logFrom - logVanishing) * zoomFactor;
			const newLogTo = logVanishing + (logTo - logVanishing) * zoomFactor;

			nextMin = fromLightweightChartsLogPrice(Math.min(newLogFrom, newLogTo), formula);
			nextMax = fromLightweightChartsLogPrice(Math.max(newLogFrom, newLogTo), formula);

			if (Number.isFinite(nextMin) && Number.isFinite(nextMax) && nextMax > nextMin) {
				setPriceScaleLinearVisibleRange(priceScale, nextMin, nextMax, true, formula);
				this.lastPriceViewportRange = { min: nextMin, max: nextMax };
			}
		}

		if (this.priceScaleWheelOverlayTimer) {
			window.clearTimeout(this.priceScaleWheelOverlayTimer);
			this.priceScaleWheelOverlayTimer = null;
		}

		this.schedulePriceOverlayUpdate();
	};

	lockMainPriceVisibleRange = (min, max, options = {}) => {
		const priceScale = this.getMainPriceScale();
		if (!priceScale || !(max > min)) return false;

		const isLog = options.isLog ?? this.state.isLogPriceScale;
		const scaleMargins = options.scaleMargins;
		const syncMinMove = options.syncMinMove !== false;

		this.manualPriceRange = null;

		if (scaleMargins) {
			priceScale.applyOptions({ scaleMargins });
		}

		if (isLog && !this.priceScaleLogZoomFormula) {
			this.priceScaleLogZoomFormula = getLightweightChartsLogFormula(min, max);
		}

		const applied = setPriceScaleLinearVisibleRange(
			priceScale,
			min,
			max,
			isLog,
			isLog ? (this.priceScaleLogZoomFormula || getLightweightChartsLogFormula(min, max)) : null,
		);

		if (applied && syncMinMove) this.syncPriceScaleMinMoveFromViewport();

		return applied;
	};

	// Tick/minMove only — never writes setVisibleRange.
	applyPriceScaleMinMoveForCurrentRange = (min, max) => {
		if (!(max > min)) return;

		if (this.priceScaleMinMoveSyncFrame) {
			cancelAnimationFrame(this.priceScaleMinMoveSyncFrame);
			this.priceScaleMinMoveSyncFrame = null;
		}

		this.lastPriceViewportRange = { min, max };
		this.applyPriceSeriesFormat();
	};

	enablePriceAutoScale = () => {
		this.manualPriceRange = null;
		this.priceScaleLogZoomFormula = null;

		if (this.state.isBullseyeViewActive) {
			this.bullseyePriceRange = null;
			this.setState({
				isBullseyeViewActive: false,
				chartNotice: null,
			}, () => {
				this.applyChartInteractionLock(false);
				this.getMainPriceScale()?.applyOptions({
					autoScale: true,
					scaleMargins: { ...DEFAULT_PRICE_SCALE_MARGINS },
				});
				this.candleSeries?.applyOptions({});
				this.scheduleOverlayUpdate();
				this.syncPriceScaleMinMoveFromViewport();
			});
			return;
		}

		this.getMainPriceScale()?.applyOptions({
			autoScale: true,
			scaleMargins: { ...DEFAULT_PRICE_SCALE_MARGINS },
		});
		this.candleSeries?.applyOptions({});
		this.scheduleOverlayUpdate();
		this.syncPriceScaleMinMoveFromViewport();
	};

	// !IMPORTANT DO NOT TOUCH. DO NOT OPTIMIZE UNLESS REQUESTED BY USER.
	// Cookie wants Log, but create stays Normal until real candle data has a
	// visible time range (same end state as Linear → AUTO → Log). No timers —
	// enter Log on the visible-logical-range event after setData/default range.
	armLogPriceScaleResyncAfterData = () => {
		if (!this.state.isLogPriceScale || !this.candleSeries) {
			this.pendingLogPriceScaleResync = false;
			return;
		}

		const priceScale = this.getMainPriceScale();
		if (!priceScale) return;

		this.manualPriceRange = null;
		this.priceScaleLogZoomFormula = null;
		this.pendingLogPriceScaleResync = true;

		priceScale.applyOptions({
			mode: PriceScaleMode.Normal,
			autoScale: true,
			scaleMargins: { ...DEFAULT_PRICE_SCALE_MARGINS },
		});
		this.candleSeries.applyOptions({});
	};

	// !IMPORTANT DO NOT TOUCH. DO NOT OPTIMIZE UNLESS REQUESTED BY USER.
	applyPendingLogPriceScaleResync = () => {
		if (!this.pendingLogPriceScaleResync) return;

		if (!this.state.isLogPriceScale || !this.candleSeries) {
			this.pendingLogPriceScaleResync = false;
			return;
		}

		const priceScale = this.getMainPriceScale();
		if (!priceScale) {
			this.pendingLogPriceScaleResync = false;
			return;
		}

		this.pendingLogPriceScaleResync = false;
		this.manualPriceRange = null;
		this.priceScaleLogZoomFormula = null;

		priceScale.applyOptions({
			mode: PriceScaleMode.Logarithmic,
			autoScale: true,
		});
		this.candleSeries.applyOptions({});
		this.syncPriceScaleMinMoveFromViewport();
		this.scheduleOverlayUpdate();
	};

	getMainPriceScale = () => (
		this.candleSeries?.priceScale?.()
		|| this.chart?.priceScale('right')
	);

	toggleLogPriceScale = () => {
		this.setState(prev => {
			const isLogPriceScale = !prev.isLogPriceScale;
			const priceScale = this.getMainPriceScale();
			const wasAutoScale = priceScale?.options?.()?.autoScale !== false;

			// Capture the current linear window BEFORE mode switch (getVisibleRange
			// after switching with autoScale on loses the panned/zoomed range).
			let restoreMin = null;
			let restoreMax = null;
			const range = priceScale?.getVisibleRange?.();

			if (
				range
				&& Number.isFinite(range.from)
				&& Number.isFinite(range.to)
			) {
				restoreMin = Math.min(range.from, range.to);
				restoreMax = Math.max(range.from, range.to);
			}

			this.manualPriceRange = null;
			this.priceScaleLogZoomFormula = null;
			priceScale?.applyOptions({
				mode: isLogPriceScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
				autoScale: true,
			});
			this.candleSeries?.applyOptions({});

			// Autoscale once for the new mode, then restore prior auto on/off + range.
			if (
				!this.state.isBullseyeViewActive
				&& !wasAutoScale
				&& Number.isFinite(restoreMin)
				&& Number.isFinite(restoreMax)
				&& restoreMax > restoreMin
			) {
				if (
					!this.lockMainPriceVisibleRange(restoreMin, restoreMax, {
						isLog: isLogPriceScale,
					})
				) {
					priceScale?.applyOptions({ autoScale: false });
				}
			}

			setCookieBoolean(PRICE_SCALE_COOKIES.logarithmic, isLogPriceScale);

			return { isLogPriceScale };
		}, () => {
			this.syncBullseyeViewIfActive();
			this.scheduleOverlayUpdate();
		});
	};

	toggleInvertedPriceScale = () => {
		this.setState(prev => {
			const isInvertedPriceScale = !prev.isInvertedPriceScale;

			this.getMainPriceScale()?.applyOptions({
				invertScale: isInvertedPriceScale,
				autoScale: !this.state.isBullseyeViewActive,
			});
			setCookieBoolean(PRICE_SCALE_COOKIES.inverted, isInvertedPriceScale);

			return { isInvertedPriceScale };
		}, () => {
			this.syncBullseyeViewIfActive();
			this.scheduleOverlayUpdate();
		});
	};

	toggleCandleGranularityMenu = () => {
		if (this.state.isCandleGranularityMenuOpen || this.state.isCandleGranularityMenuClosing) {
			this.closeCandleGranularityMenu();
			return;
		}

		this.setState({
			isCandleGranularityMenuOpen: true,
			isCandleGranularityMenuClosing: false,
		});
	};

	closeCandleGranularityMenu = () => {
		if (!this.state.isCandleGranularityMenuOpen || this.state.isCandleGranularityMenuClosing) {
			return;
		}

		if (this.candleGranularityMenuCloseTimer) {
			window.clearTimeout(this.candleGranularityMenuCloseTimer);
		}

		this.setState({ isCandleGranularityMenuClosing: true });
		this.candleGranularityMenuCloseTimer = window.setTimeout(() => {
			this.candleGranularityMenuCloseTimer = null;
			this.setState({
				isCandleGranularityMenuOpen: false,
				isCandleGranularityMenuClosing: false,
			});
		}, DROPDOWN_TRANSITION_MS);
	};

	setCandleGranularity = (seconds) => {
		const periodGranularity = normalizeCandleGranularity(seconds);
		const periodDays = getPeriodDaysForGranularity(periodGranularity);

		if (
			periodGranularity === Number(this.state.periodGranularity)
			&& periodDays === Number(this.state.periodDays)
		) {
			this.closeCandleGranularityMenu();
			return;
		}

		if (this.candleGranularityMenuCloseTimer) {
			window.clearTimeout(this.candleGranularityMenuCloseTimer);
			this.candleGranularityMenuCloseTimer = null;
		}

		setCandleGranularityCookie(periodGranularity);
		this.setState({
			periodGranularity,
			periodDays,
			isCandleGranularityMenuOpen: false,
			isCandleGranularityMenuClosing: false,
		}, this.loadMarket);
	};

	/**
	 * Candle under cursor: same series bar LWC uses for the time label, then map
	 * that bar's chart time onto state.candles. Never treat logical range bounds as
	 * candles[] indexes — that window can miss the real bar and highlight a neighbor.
	 */
	resolveCandleIndexFromX = (x) => {
		const stateCandles = this.state.candles;

		if (
			!this.chart
			|| !this.candleSeries
			|| !Array.isArray(stateCandles)
			|| !stateCandles.length
			|| !Number.isFinite(x)
		) {
			return null;
		}

		const logicalIndex = this.chart.timeScale().coordinateToLogical?.(x);

		if (!Number.isFinite(logicalIndex)) return null;

		const bar = (
			this.candleSeries.dataByIndex(logicalIndex, MismatchDirection.None)
			|| this.candleSeries.dataByIndex(logicalIndex, MismatchDirection.NearestLeft)
			|| this.candleSeries.dataByIndex(logicalIndex, MismatchDirection.NearestRight)
		);

		if (!bar) return null;

		const chartTs = Number(
			bar.time != null && typeof bar.time === "object"
				? NaN
				: bar.time
		);

		if (!Number.isFinite(chartTs)) return null;

		return this.findNearestCandleIndexByChartTime(stateCandles, chartTs);
	};

	getHoveredCandleIndexFromX = (x) => this.resolveCandleIndexFromX(x);

	getCrosshairTimeFromX = (x) => {
		const candles = this.state.candles;
		const fallbackTime = candles[candles.length - 1]?.time;
		const index = this.resolveCandleIndexFromX(x);

		if (index != null && candles[index]) {
			return Number(candles[index].time);
		}

		return fallbackTime;
	};

	syncNativeCrosshair = (price, x) => {
		if (!this.chart?.setCrosshairPosition || !this.candleSeries) return;
		if (!Number.isFinite(price)) return;

		const time = this.getCrosshairTimeFromX(x);

		if (!Number.isFinite(time)) return;
		this.chart.setCrosshairPosition(price, toChartTime(time), this.candleSeries);
	};

	clearNativeCrosshair = () => {
		this.chart?.clearCrosshairPosition?.();
	};

	setCrosshairTimeLabelVisible = (visible) => {
		if (!this.chart || visible === this.isCrosshairTimeLabelVisible) return;

		this.isCrosshairTimeLabelVisible = visible;
		this.chart.applyOptions({
			crosshair: {
				vertLine: {
					labelVisible: visible,
				},
			},
		});
	};

	handleFreeCrosshairMove = (event) => {
		this.pendingPointerMove = {
			clientX: event.clientX,
			clientY: event.clientY,
		};

		if (this.pointerMoveFrame) return;

		this.pointerMoveFrame = window.requestAnimationFrame(() => {
			this.pointerMoveFrame = null;
			const pending = this.pendingPointerMove;
			this.pendingPointerMove = null;

			if (pending) {
				this.applyFreeCrosshairMove(pending);
			}
		});
	};

	applyFreeCrosshairMove = ({ clientX, clientY }) => {
		const el = this.chartRef.current;
		if (!el) return;

		const rect = el.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;

		if (x < 0 || x > rect.width) {
			this.handleFreeCrosshairLeave();
			return;
		}

		// In-progress MT (1st point only): skip candle hover / order-scale chrome
		// so the preview stays light. Locked MT keeps normal scale hover so
		// Bookmark / Add Order still appear.
		const measurementInProgress = Boolean(
			this.state.measurementStart && !this.state.measurementEnd,
		);

		if (measurementInProgress) {
			if (this.state.hoveredVolumeIndex !== null) {
				this.syncVolumeSeries(this.state.candles, null);
			}

			this.setState(prev => (
				Math.abs((prev.freeCrosshairX ?? -9999) - x) < 0.5
				&& Math.abs((prev.pointerPosition?.y ?? -9999) - y) < 0.5
				&& prev.hoveredVolumeIndex === null
				&& prev.orderScaleHover === null
					? null
					: {
						freeCrosshairX: x,
						pointerPosition: { x, y },
						hoveredVolumeIndex: null,
						orderScaleHover: null,
					}
			));
			return;
		}

		const priceScaleWidth = Math.max(this.chart?.priceScale('right')?.width?.() || 0, 76);
		const scaleLeft = rect.width - priceScaleWidth;
		const hover = this.state.orderScaleHover;
		const isMovingTowardOrderHover = hover
			&& Math.abs(y - hover.y) <= 24
			&& x >= hover.x - 36
			&& x <= rect.width;
		const isOverPriceScale = x >= scaleLeft && x <= rect.width;
		const firstCandleTime = this.state.candles[0]?.time;
		const lastCandleTime = this.state.candles[this.state.candles.length - 1]?.time;
		const firstCandleX = Number.isFinite(firstCandleTime) ? this.timeToX(firstCandleTime) : null;
		const lastCandleX = Number.isFinite(lastCandleTime) ? this.timeToX(lastCandleTime) : null;
		const isOverCandleZone = (
			Number.isFinite(firstCandleX)
			&& Number.isFinite(lastCandleX)
			&& x >= firstCandleX
			&& x <= lastCandleX
		);
		const scalePrice = isOverPriceScale ? this.candleSeries?.coordinateToPrice(y) : null;
		const bridgePrice = isMovingTowardOrderHover ? this.candleSeries?.coordinateToPrice(y) : null;
		const orderScaleHover = Number.isFinite(scalePrice)
			? {
				price: scalePrice,
				x: Math.max(18, scaleLeft - 38),
				y: Math.min(rect.height - 20, Math.max(20, y)),
			}
			: null;

		if (orderScaleHover) {
			this.syncNativeCrosshair(orderScaleHover.price, Math.min(x, scaleLeft - 1));
		} else if (isMovingTowardOrderHover && Number.isFinite(bridgePrice)) {
			this.syncNativeCrosshair(bridgePrice, hover.x);
		}

		this.setCrosshairTimeLabelVisible(isOverCandleZone);

		const nextHoveredVolumeIndex = isOverCandleZone
			? this.getHoveredCandleIndexFromX(x)
			: null;

		if (nextHoveredVolumeIndex !== this.state.hoveredVolumeIndex) {
			this.syncVolumeSeries(this.state.candles, nextHoveredVolumeIndex);
		}

		this.setState(prev => (
			Math.abs((prev.freeCrosshairX ?? -9999) - x) < 0.5
			&& Math.abs((prev.pointerPosition?.y ?? -9999) - y) < 0.5
			&& prev.hoveredVolumeIndex === nextHoveredVolumeIndex
			&& (prev.orderScaleHover?.price ?? null) === (orderScaleHover?.price ?? (isMovingTowardOrderHover ? bridgePrice : null))
			&& Math.abs((prev.orderScaleHover?.y ?? -9999) - (isMovingTowardOrderHover ? Math.min(rect.height - 20, Math.max(20, y)) : orderScaleHover?.y ?? -9999)) < 0.5
				? null
				: {
					freeCrosshairX: x,
					pointerPosition: {
						x,
						y,
					},
					hoveredVolumeIndex: nextHoveredVolumeIndex,
					orderScaleHover: isMovingTowardOrderHover && prev.orderScaleHover
						? {
							...prev.orderScaleHover,
							price: Number.isFinite(bridgePrice) ? bridgePrice : prev.orderScaleHover.price,
							y: Math.min(rect.height - 20, Math.max(20, y)),
						}
						: orderScaleHover,
				}
		));
	};

	handleFreeCrosshairLeave = (event) => {
		if (event?.relatedTarget?.closest?.(".e__scale-hover-actions")) return;
		if (this.isPointerOnOrderPlus) return;

		if (this.pointerMoveFrame) {
			cancelAnimationFrame(this.pointerMoveFrame);
			this.pointerMoveFrame = null;
		}
		this.pendingPointerMove = null;
		this.setCrosshairTimeLabelVisible(false);

		if (this.state.hoveredVolumeIndex !== null) {
			this.syncVolumeSeries(this.state.candles, null);
		}

		if (
			this.state.freeCrosshairX !== null
			|| this.state.pointerPosition !== null
			|| this.state.hoveredVolumeIndex !== null
		) {
			this.setState({
				freeCrosshairX: null,
				pointerPosition: null,
				hoveredVolumeIndex: null,
			});
		}
	};

	handleChartShellLeave = () => {
		this.clearNativeCrosshair();

		if (!this.state.orderTicket && this.state.orderScaleHover) {
			this.setState({ orderScaleHover: null });
		}
	};

	handleOrderHoverEnter = () => {
		this.isPointerOnOrderPlus = true;

		const hover = this.state.orderScaleHover;
		if (hover) {
			this.syncNativeCrosshair(hover.price, hover.x);
		}
	};

	handleOrderHoverLeave = () => {
		this.isPointerOnOrderPlus = false;

		if (!this.state.orderTicket) {
			this.setState({ orderScaleHover: null });
		}
	};

	handleOrderHoverMove = (event) => {
		event?.stopPropagation?.();

		const hover = this.state.orderScaleHover;
		const el = this.chartRef.current;
		if (!hover || !el) return;

		const rect = el.getBoundingClientRect();
		const y = event.clientY - rect.top;
		const price = this.candleSeries?.coordinateToPrice(y);

		if (!Number.isFinite(price)) return;

		const nextHover = {
			...hover,
			price,
			y: Math.min(rect.height - 20, Math.max(20, y)),
		};

		this.syncNativeCrosshair(nextHover.price, nextHover.x);
		this.setState({ orderScaleHover: nextHover });
	};

	getTimeScaleBarSpacingOptions = (width) => {
		const chartWidth = Number(width);
		const granularity = Number(this.state.periodGranularity) || 300;

		if (!Number.isFinite(chartWidth) || chartWidth <= 0) {
			return {};
		}

		const maxVisibleBars = Math.ceil((MAX_VISIBLE_PERIOD_DAYS * 86400) / granularity);

		return {
			maxBarSpacing: 0,
			minBarSpacing: chartWidth / maxVisibleBars,
		};
	};

	handleResize = () => {
		if (!this.chart || !this.chartRef.current) return;

		const width = this.chartRef.current.clientWidth;
		const height = this.chartRef.current.clientHeight;

		this.chart.applyOptions({ width, height });
		this.chart.timeScale().applyOptions(this.getTimeScaleBarSpacingOptions(width));
		this.syncPriceScaleMinMoveFromViewport();
		this.setState({ chartSize: { width, height } }, () => {
			if (this.state.isBullseyeViewActive) {
				this.frameChartTo24hFocus();
			}
		});
	};

	getVisibleRangeSnapshot = () => {
		if (!this.chart || !this.state.candles.length) return null;

		const timeScale = this.chart.timeScale();

		return {
			logicalRange: timeScale.getVisibleLogicalRange?.() ?? null,
			timeRange: timeScale.getVisibleRange?.() ?? null,
		};
	};

	restoreVisibleRange = (snapshot) => {
		if (this.state.isBullseyeViewActive) {
			this.frameChartTo24hFocus();
			return true;
		}

		const timeScale = this.chart.timeScale();

		if (snapshot.logicalRange && timeScale.setVisibleLogicalRange) {
			timeScale.setVisibleLogicalRange(snapshot.logicalRange);
			return true;
		}

		if (snapshot.timeRange && timeScale.setVisibleRange) {
			timeScale.setVisibleRange(snapshot.timeRange);
			return true;
		}

		return false;
	};

	getLoadedCandleGranularity = () => {
		if (this.state.loadedPeriodGranularity) {
			return Number(this.state.loadedPeriodGranularity);
		}

		return Number(this.state.loadedPeriodDays) <= DEFAULT_PERIOD_DAYS ? 3600 : 21600;
	};

	// Series bars store toChartTime(...); match against that on the full candles array.
	findNearestCandleIndexByChartTime = (candles, chartTime) => {
		const targetTime = Number(chartTime);

		if (!Array.isArray(candles) || !candles.length || !Number.isFinite(targetTime)) {
			return null;
		}

		let low = 0;
		let high = candles.length - 1;

		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const candleChartTime = Number(toChartTime(candles[middle].time));

			if (candleChartTime === targetTime) return middle;
			if (candleChartTime < targetTime) low = middle + 1;
			else high = middle - 1;
		}

		const right = Math.min(candles.length - 1, low);
		const left = Math.max(0, right - 1);
		const leftTime = Number(toChartTime(candles[left].time));
		const rightTime = Number(toChartTime(candles[right].time));
		const leftDistance = Math.abs(leftTime - targetTime);
		const rightDistance = Math.abs(rightTime - targetTime);

		return leftDistance <= rightDistance ? left : right;
	};

	buildDisplayCandles = (historicalCandles, currentCandle) => {
		const historical = Array.isArray(historicalCandles) ? historicalCandles : [];

		if (!currentCandle) return historical;

		const lastHistorical = historical[historical.length - 1];

		if (lastHistorical && Number(lastHistorical.time) === Number(currentCandle.time)) {
			return [...historical.slice(0, -1), currentCandle];
		}

		return [...historical, currentCandle];
	};

	splitCandlesFromApi = (candles) => {
		if (!Array.isArray(candles) || !candles.length) {
			return { historicalCandles: [], currentCandle: null };
		}

		return {
			historicalCandles: candles.slice(0, -1),
			currentCandle: { ...candles[candles.length - 1] },
		};
	};

	setCandleData = (historicalCandles, currentCandle, extraState = null, callback) => {
		this.setState({
			historicalCandles,
			currentCandle,
			candles: this.buildDisplayCandles(historicalCandles, currentCandle),
			...(extraState || {}),
		}, callback);
	};

	fetchOfficialRecentCandles = (endTime, options = {}) => {
		const baseCurrency = this.state.baseCurrency.trim().toUpperCase();
		const granularity = this.getLoadedCandleGranularity();
		const startTime = Number(options.startTime);
		const limit = Number(options.limit);
		const hasStartTime = Number.isFinite(startTime) && startTime > 0;

		if (!baseCurrency || !Number.isFinite(Number(endTime))) {
			return Promise.resolve([]);
		}

		return api.getCandles({
			product_id: `${baseCurrency}-USD`,
			days: Number(this.state.loadedPeriodDays) || DEFAULT_PERIOD_DAYS,
			granularity,
			end_time: Math.max(0, Math.floor(Number(endTime))),
			...(hasStartTime
				? { start_time: Math.floor(startTime) }
				: { limit: Math.max(1, Math.min(300, Number.isFinite(limit) ? limit : 3)) }),
			_: Date.now(),
		}).then(response => this.parseCandlesResponse(response.data).candles)
			.catch(() => []);
	};

	rememberLiveCandleBucketTime = (time) => {
		const bucket = Number(time);

		if (!Number.isFinite(bucket) || bucket <= 0) return;

		if (
			!Number.isFinite(Number(this.lastLiveCandleBucketTime))
			|| bucket > Number(this.lastLiveCandleBucketTime)
		) {
			this.lastLiveCandleBucketTime = bucket;
		}
	};

	backfillCandlesAfterReconnect = () => {
		const granularity = this.getLoadedCandleGranularity();
		const fromTime = Number(this.lastLiveCandleBucketTime);

		if (!Number.isFinite(fromTime) || fromTime <= 0) {
			const fallback = Number(
				this.state.currentCandle?.time
				?? this.state.historicalCandles?.[this.state.historicalCandles.length - 1]?.time
			);
			if (Number.isFinite(fallback) && fallback > 0) {
				this.lastLiveCandleBucketTime = fallback;
			} else {
				return;
			}
		}

		const startTime = Number(this.lastLiveCandleBucketTime);
		if (!Number.isFinite(granularity) || granularity <= 0 || !Number.isFinite(startTime)) {
			return;
		}

		const endTime = Math.floor(Date.now() / 1000);
		const bucketCount = Math.floor((endTime - startTime) / granularity) + 3;
		const limit = Math.max(2, Math.min(300, bucketCount));
		const requestId = ++this.candleBackfillRequestId;

		this.fetchOfficialRecentCandles(endTime, { limit }).then((officialCandles) => {
			if (requestId !== this.candleBackfillRequestId) return;
			this.applyOfficialCoinbaseCandles(officialCandles);
		});
	};

	officialCandleSeriesChanged = (previousCandles, nextCandles) => {
		const previous = Array.isArray(previousCandles) ? previousCandles : [];
		const next = Array.isArray(nextCandles) ? nextCandles : [];

		if (previous.length !== next.length) return true;

		for (let index = 0; index < next.length; index += 1) {
			const left = previous[index];
			const right = next[index];

			if (
				Number(left?.time) !== Number(right?.time)
				|| Number(left?.open) !== Number(right?.open)
				|| Number(left?.high) !== Number(right?.high)
				|| Number(left?.low) !== Number(right?.low)
				|| Number(left?.close) !== Number(right?.close)
				|| Number(left?.volume) !== Number(right?.volume)
			) {
				return true;
			}
		}

		return false;
	};

	applyOfficialCoinbaseCandles = (officialCandles) => {
		const incoming = Array.isArray(officialCandles) ? officialCandles : [];

		if (!incoming.length) return;

		const previousCandles = this.buildDisplayCandles(
			this.state.historicalCandles,
			this.state.currentCandle,
		);
		const previousLastTime = Number(previousCandles[previousCandles.length - 1]?.time);

		// Previous candles: Coinbase only. Overwrite matching times with official
		// OHLC/volume; add missing official times. Keep local live if Coinbase did
		// not return that time yet (socket still owns live ticks between syncs).
		const byTime = new Map();

		(Array.isArray(previousCandles) ? previousCandles : []).forEach(candle => {
			const time = Number(candle?.time);

			if (!Number.isFinite(time) || time <= 0) return;

			byTime.set(time, candle);
		});

		incoming.forEach(candle => {
			const time = Number(candle?.time);

			if (!Number.isFinite(time) || time <= 0) return;

			byTime.set(time, candle);
		});

		const merged = [...byTime.values()].sort(
			(left, right) => Number(left.time) - Number(right.time),
		);

		if (!merged.length || !this.officialCandleSeriesChanged(previousCandles, merged)) {
			return;
		}

		const nextLastTime = Number(merged[merged.length - 1]?.time);
		const addedNewTime = Number.isFinite(nextLastTime)
			&& (!Number.isFinite(previousLastTime) || nextLastTime > previousLastTime);
		const onlyCurrentUpdated = (
			!addedNewTime
			&& previousCandles.length === merged.length
			&& Number(previousCandles[previousCandles.length - 1]?.time) === nextLastTime
			&& !this.officialCandleSeriesChanged(
				previousCandles.slice(0, -1),
				merged.slice(0, -1),
			)
		);
		const split = this.splitCandlesFromApi(merged);

		this.setState({
			historicalCandles: split.historicalCandles,
			currentCandle: split.currentCandle,
			candles: merged,
		}, () => {
			this.rememberLiveCandleBucketTime(split.currentCandle?.time);

			if (onlyCurrentUpdated) {
				this.updateCurrentCandleOnChart(split.currentCandle);
				this.updateCurrentVwapPoint(split.currentCandle);
			} else {
				this.syncCandleSeries(this.state.candles);
				this.syncVwapSeries(this.state.candles);
			}

			if (addedNewTime) {
				this.refreshTdSequentialAfterClosedCandle(nextLastTime);
				this.refreshDepthRangeFromFirstLoad();
				this.schedulePriceOverlayUpdate();
			}

			this.syncBullseyeViewIfActive();
		});
	};

	stopOfficialCandlePoll = () => {
		this.officialCandlePollRequestId += 1;
		this.officialCandlePollInFlight = false;
		this.lastOfficialCandleSyncAt = 0;

		if (this.officialCandlePollTimer) {
			window.clearTimeout(this.officialCandlePollTimer);
			this.officialCandlePollTimer = null;
		}
	};

	maybeSyncOfficialLiveCandles = () => {
		if (
			this.officialCandlePollInFlight
			|| this.officialCandlePollTimer
			|| this.state.isLoading
		) {
			return;
		}

		const granularity = Number(this.getLoadedCandleGranularity());
		const currentCandleTime = Number(this.state.currentCandle?.time);

		if (!Number.isFinite(granularity) || granularity <= 0) return;
		if (!Number.isFinite(currentCandleTime) || currentCandleTime <= 0) return;

		const nowSec = Math.floor(Date.now() / 1000);
		const nowBucket = Math.floor(nowSec / granularity) * granularity;
		if (!(nowBucket > currentCandleTime)) return;

		const lastSync = Number(this.lastOfficialCandleSyncAt) || 0;
		if (nowSec - lastSync < granularity) return;

		this.lastOfficialCandleSyncAt = nowSec;
		// Wait ≥1s after the bucket rolls so Coinbase can settle closed candles.
		this.officialCandlePollTimer = window.setTimeout(() => {
			this.officialCandlePollTimer = null;
			this.fetchOfficialCandlesOnNewLiveTime();
		}, 1000);
	};

	fetchOfficialCandlesOnNewLiveTime = () => {
		if (this.officialCandlePollInFlight || this.state.isLoading) return;

		const endTime = Math.floor(Date.now() / 1000);
		if (!Number.isFinite(endTime) || endTime <= 0) return;

		const series = this.buildDisplayCandles(
			this.state.historicalCandles,
			this.state.currentCandle,
		);
		// FROM = time of the candle 4 from the end. Sparse Coinbase buckets mean
		// a wall-clock window can return fewer candles than the count implies.
		const fromIndex = Math.max(0, series.length - 4);
		const startTime = Number(series[fromIndex]?.time);

		if (!Number.isFinite(startTime) || startTime <= 0 || startTime >= endTime) return;

		const requestId = ++this.officialCandlePollRequestId;
		this.officialCandlePollInFlight = true;
		console.log(`[candle] fetch from=${startTime} to=${endTime}`);

		this.fetchOfficialRecentCandles(endTime, { startTime }).then(officialCandles => {
			if (requestId !== this.officialCandlePollRequestId) return;
			this.applyOfficialCoinbaseCandles(officialCandles);
		}).finally(() => {
			if (requestId === this.officialCandlePollRequestId) {
				this.officialCandlePollInFlight = false;
			}
		});
	};

	buildDepthStateFromMessage = (prev, depthMessage, latestPrice) => {
		if (
			!depthMessage?.depth
			|| !Array.isArray(depthMessage.depth.bids)
			|| !Array.isArray(depthMessage.depth.asks)
			|| !prev.depth
		) {
			return prev.depth;
		}

		const minPrice = Number(
			this.pinnedMarketDepthRange?.min_price ?? prev.depth.min_price,
		);
		const maxPrice = Number(
			this.pinnedMarketDepthRange?.max_price ?? prev.depth.max_price,
		);
		const isInRange = level => {
			const levelPrice = Number(level.price);

			return Number.isFinite(levelPrice)
				&& (!Number.isFinite(minPrice) || levelPrice >= minPrice)
				&& (!Number.isFinite(maxPrice) || levelPrice <= maxPrice);
		};
		const bids = depthMessage.depth.bids.filter(isInRange);
		const asks = depthMessage.depth.asks.filter(isInRange);

		if (!bids.length && !asks.length) return prev.depth;

		return {
			...prev.depth,
			min_price: minPrice,
			max_price: maxPrice,
			current_price: Number.isFinite(Number(depthMessage.depth.current_price))
				? Number(depthMessage.depth.current_price)
				: Number.isFinite(latestPrice)
					? latestPrice
					: prev.depth.current_price,
			bids,
			asks,
		};
	};

	updateCurrentCandleOnChart = (
		currentCandle,
		highlightedIndex = this.state.hoveredVolumeIndex,
		candles = this.state.candles,
	) => {
		if (!currentCandle || !this.candleSeries) return;

		this.candleSeries.update(toChartPoint(currentCandle));

		if (this.volumeSeries) {
			const resolvedHighlightIndex = Number.isFinite(highlightedIndex)
				? highlightedIndex
				: candles.length - 1;

			this.volumeSeries.update({
				time: toChartTime(currentCandle.time),
				value: this.getCandleVolumeUsd(currentCandle),
				color: this.getVolumeBarColor(
					currentCandle,
					resolvedHighlightIndex === candles.length - 1,
				),
			});
		}
	};

	syncCandleSeries = (candles = this.state.candles) => {
		if (!Array.isArray(candles) || !candles.length) return;

		this.candleSeries?.setData(toChartData(candles));
		this.plottedCandles = candles;
		this.syncVolumeSeries(candles);
		this.syncMacdOverlay(candles);
		this.syncBullseyeViewIfActive();

		if (this.state.measurementStart) {
			this.scheduleOverlayUpdate();
		}
	};

	syncMacdOverlay = (candles = this.state.candles) => {
		this.cachedMacdPoints = this.buildMacdData(candles);
		this.cachedPvtPoints = this.buildPvtSeriesData(candles);
		this.cachedMacdOverlayKey = null;
		this.cachedMacdOverlayModel = null;
	};

	scheduleOlderCandlesLoad = (
		targetFrom,
		delay = OLDER_CANDLES_INTERACTION_IDLE_MS,
	) => {
		if (!Number.isFinite(targetFrom)) return;

		this.pendingOlderCandlesTargetFrom = targetFrom;

		if (this.olderCandlesLoadTimer) {
			window.clearTimeout(this.olderCandlesLoadTimer);
			this.olderCandlesLoadTimer = null;
		}

		if (this.olderCandlesLoadInFlight) return;

		this.olderCandlesLoadTimer = window.setTimeout(() => {
			this.olderCandlesLoadTimer = null;
			this.pendingOlderCandlesTargetFrom = null;
			this.loadOlderCandles();
		}, delay);
	};

	finishOlderCandlesLoad = (callback, nextLoadDelay = OLDER_CANDLES_INTERACTION_IDLE_MS) => {
		this.olderCandlesLoadInFlight = false;
		this.setState({ isLoadingOlderCandles: false }, () => {
			callback?.();

			const range = this.chart?.timeScale()?.getVisibleLogicalRange?.();
			if (
				this.state.hasMoreOlderCandles
				&& range
				&& Number.isFinite(range.from)
				&& range.from <= 24
			) {
				this.scheduleOlderCandlesLoad(range.from, nextLoadDelay);
			}
		});
	};

	applyOlderCandlesWhenIdle = ({
		baseCurrency,
		candles,
		hasMore,
		requestId,
	}) => {
		const idleFor = performance.now() - this.lastVisibleRangeChangeAt;

		if (idleFor < OLDER_CANDLES_INTERACTION_IDLE_MS) {
			if (this.olderCandlesApplyTimer) {
				window.clearTimeout(this.olderCandlesApplyTimer);
			}

			this.olderCandlesApplyTimer = window.setTimeout(() => {
				this.olderCandlesApplyTimer = null;
				this.applyOlderCandlesWhenIdle({
					baseCurrency,
					candles,
					hasMore,
					requestId,
				});
			}, OLDER_CANDLES_INTERACTION_IDLE_MS - idleFor);
			return;
		}

		if (
			requestId !== this.marketRequestId
			|| baseCurrency !== this.state.baseCurrency
		) {
			this.finishOlderCandlesLoad();
			return;
		}

		if (!candles.length) {
			this.setState({ hasMoreOlderCandles: hasMore }, () => {
				this.finishOlderCandlesLoad();
			});
			return;
		}

		const candlesByTime = new Map();
		[...candles, ...this.state.historicalCandles].forEach(candle => {
			candlesByTime.set(Number(candle.time), candle);
		});
		const historicalCandles = [...candlesByTime.values()]
			.sort((left, right) => Number(left.time) - Number(right.time));

		this.isApplyingOlderCandles = true;
		this.setCandleData(historicalCandles, this.state.currentCandle, null, () => {
			this.syncCandleSeries(this.state.candles);
			this.syncVwapSeries(this.state.candles);
			this.syncTdSequentialSeries(this.state.tdSequential, this.state.candles);
			this.refreshDepthRangeFromFirstLoad();
			this.scheduleOverlayUpdate();
			this.setState({ hasMoreOlderCandles: hasMore }, () => {
				this.isApplyingOlderCandles = false;
				this.syncBullseyeViewIfActive();
				this.finishOlderCandlesLoad();
			});
		});
	};

	loadOlderCandles = async () => {
		if (
			this.olderCandlesLoadInFlight
			|| this.isMarketTransitioning
			|| this.state.isLoading
			|| !this.state.hasMoreOlderCandles
			|| !this.state.candles.length
		) {
			return;
		}

		const oldestCandle = this.state.historicalCandles[0] || this.state.candles[0];
		const oldestTime = Number(oldestCandle?.time);
		const baseCurrency = this.state.baseCurrency.trim().toUpperCase();
		const granularity = this.getLoadedCandleGranularity();
		const requestId = this.marketRequestId;

		if (!baseCurrency || !Number.isFinite(oldestTime) || !Number.isFinite(granularity)) return;

		this.olderCandlesLoadInFlight = true;
		this.setState({ isLoadingOlderCandles: true });

		try {
			const response = await api.getCandles({
				product_id: `${baseCurrency}-USD`,
				days: Number(this.state.loadedPeriodDays) || DEFAULT_PERIOD_DAYS,
				granularity,
				end_time: Math.max(0, oldestTime - 1),
				limit: OLDER_CANDLES_BATCH_SIZE,
				_: Date.now(),
			});

			if (
				requestId !== this.marketRequestId
				|| baseCurrency !== this.state.baseCurrency
			) {
				this.finishOlderCandlesLoad();
				return;
			}

			const olderCandles = this.parseCandlesResponse(response.data).candles
				.filter(candle => Number(candle.time) < oldestTime);

			this.applyOlderCandlesWhenIdle({
				baseCurrency,
				candles: olderCandles,
				hasMore: olderCandles.length > 0,
				requestId,
			});
		} catch {
			if (requestId !== this.marketRequestId) {
				this.finishOlderCandlesLoad();
				return;
			}

			this.finishOlderCandlesLoad(null, OLDER_CANDLES_RETRY_MS);
		}
	};

	getDefaultViewportLogicalRange = (candles) => {
		if (!Array.isArray(candles) || !candles.length) return null;

		const lastIndex = candles.length - 1;
		const firstIndex = 0;
		const visibleBars = lastIndex + 1;
		const depthRatio = DEFAULT_DEPTH_CHART_WIDTH_RATIO;
		const timelinePaddingBars = visibleBars * depthRatio / (1 - depthRatio);

		return {
			from: firstIndex,
			to: lastIndex + timelinePaddingBars,
		};
	};

	getDepthRangeForCandles = (candles) => {
		if (!Array.isArray(candles) || !candles.length) {
			return null;
		}

		const chartMin = Math.min(...candles.map(candle => candle.low));
		const chartMax = Math.max(...candles.map(candle => candle.high));

		if (!Number.isFinite(chartMin) || !Number.isFinite(chartMax)) {
			return null;
		}

		return {
			min_price: chartMin * (1 - DEPTH_CHART_PADDING_RATIO),
			max_price: chartMax * (1 + DEPTH_CHART_PADDING_RATIO),
		};
	};

	refreshDepthRangeFromFirstLoad = () => {
		const depthRange = this.getDepthRangeForCandles(this.state.candles);
		const baseCurrency = this.state.baseCurrency.trim().toUpperCase();

		if (!depthRange || !baseCurrency) {
			return Promise.resolve();
		}

		const previousRange = this.pinnedMarketDepthRange;
		const rangeUnchanged = (
			previousRange
			&& Number(previousRange.min_price) === Number(depthRange.min_price)
			&& Number(previousRange.max_price) === Number(depthRange.max_price)
		);

		if (rangeUnchanged) {
			return Promise.resolve();
		}

		const productId = `${baseCurrency}-USD`;
		const periodDays = Number(this.state.loadedPeriodDays || this.state.periodDays) || DEFAULT_PERIOD_DAYS;
		const periodGranularity = Number(this.state.loadedPeriodGranularity || this.state.periodGranularity) || 300;
		const requestId = this.marketRequestId;

		this.pinnedMarketDepthRange = depthRange;

		return api.getDepth({
			product_id: productId,
			min_price: depthRange.min_price,
			max_price: depthRange.max_price,
		}).then(depthResponse => {
			if (requestId !== this.marketRequestId) return;

			this.setState({
				depth: {
					...depthResponse.data,
					min_price: depthRange.min_price,
					max_price: depthRange.max_price,
				},
			}, () => {
				this.connectLiveMarket(productId, periodDays, periodGranularity, depthRange);
				this.scheduleOverlayUpdate();
			});
		}).catch(() => {
			if (requestId !== this.marketRequestId) return;

			this.connectLiveMarket(productId, periodDays, periodGranularity, depthRange);
		});
	};

	parseCandlesResponse = (data) => {
		const payload = Array.isArray(data)
			? { candles: data }
			: (data && typeof data === "object" ? data : { candles: [] });
		const candles = this.normalizeCandles(payload.candles);
		const priceRange = (
			payload.price_range
			&& Number.isFinite(Number(payload.price_range.min_price))
			&& Number.isFinite(Number(payload.price_range.max_price))
		)
			? {
				min_price: Number(payload.price_range.min_price),
				max_price: Number(payload.price_range.max_price),
			}
			: this.getDepthRangeForCandles(candles);

		return { candles, priceRange };
	};

	applyDefaultVisibleRange = (candles = this.state.candles) => {
		if (this.state.isBullseyeViewActive) {
			this.frameChartTo24hFocus();
			return true;
		}

		if (!this.chart || !Array.isArray(candles) || !candles.length) return false;

		const logicalRange = this.getDefaultViewportLogicalRange(candles);

		if (!logicalRange || !this.chart.timeScale().setVisibleLogicalRange) return false;

		this.priceScaleLogZoomFormula = null;
		this.getMainPriceScale()?.applyOptions({
			autoScale: true,
			scaleMargins: { ...DEFAULT_PRICE_SCALE_MARGINS },
		});
		this.chart.timeScale().applyOptions({ rightOffset: 0 });
		this.chart.timeScale().setVisibleLogicalRange(logicalRange);
		this.scheduleOverlayUpdate();

		requestAnimationFrame(() => {
			if (!this.chart) return;

			this.getMainPriceScale()?.applyOptions({ autoScale: true });
			this.scheduleOverlayUpdate();
			this.syncPriceScaleMinMoveFromViewport();
		});

		return true;
	};

	frameChartTo24hFocus = () => {
		const candles = this.state.candles;

		if (!this.chart || !Array.isArray(candles) || !candles.length) return;

		const granularity = Number(this.getLoadedCandleGranularity());
		const nowSec = Date.now() / 1000;
		const nowBucket = Number.isFinite(granularity) && granularity > 0
			? Math.floor(nowSec / granularity) * granularity
			: nowSec;

		let lastIndex = candles.length - 1;

		while (lastIndex > 0 && Number(candles[lastIndex].time) > nowBucket) {
			lastIndex -= 1;
		}

		const now = Number(candles[lastIndex].time);

		if (!Number.isFinite(now)) return;

		const cutoff24 = now - 24 * 60 * 60;
		let n = 0;

		for (let index = lastIndex; index >= 0; index -= 1) {
			if (Number(candles[index].time) < cutoff24) break;
			n += 1;
		}

		if (n < 1) return;

		const nPlusNIndex = lastIndex - n - n + 1;
		const from = nPlusNIndex;
		const to = from + n + n + n - 1;
		const first24Index = nPlusNIndex >= 0 ? nPlusNIndex + n : lastIndex - n + 1;

		let min = Infinity;
		let max = -Infinity;

		for (let index = first24Index; index <= lastIndex; index += 1) {
			const low = Number(candles[index].low);
			const high = Number(candles[index].high);

			if (Number.isFinite(low)) min = Math.min(min, low);
			if (Number.isFinite(high)) max = Math.max(max, high);
		}

		if (!Number.isFinite(min) || !Number.isFinite(max)) {
			this.isApplyingBullseyeFrame = false;
			return;
		}

		if (max <= min) {
			const pad = Math.abs(min) * 0.001 || 1;
			min -= pad;
			max += pad;
		}

		// Keep prices strictly positive for logarithmic scale.
		if (this.state.isLogPriceScale) {
			min = Math.max(min, Number.EPSILON);
			max = Math.max(max, min * 1.000001);
		}

		this.manualPriceRange = null;
		this.priceScaleLogZoomFormula = null;
		this.bullseyePriceRange = { min, max };

		const priceScale = this.getMainPriceScale();
		const current = this.chart.timeScale().getVisibleLogicalRange?.();
		const rangeNeedsUpdate = (
			!current
			|| Math.abs(current.from - from) > 1e-4
			|| Math.abs(current.to - to) > 1e-4
		);

		if (this.bullseyeFrameRaf != null) {
			window.cancelAnimationFrame(this.bullseyeFrameRaf);
			this.bullseyeFrameRaf = null;
		}

		this.isApplyingBullseyeFrame = true;
		priceScale?.applyOptions({
			autoScale: true,
			scaleMargins: { ...FRAME_24H_PRICE_SCALE_MARGINS },
			mode: this.state.isLogPriceScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
		});
		this.candleSeries?.applyOptions({});
		if (rangeNeedsUpdate) {
			this.chart.timeScale().setVisibleLogicalRange?.({ from, to });
		}
		this.bullseyeFrameRaf = window.requestAnimationFrame(() => {
			this.bullseyeFrameRaf = window.requestAnimationFrame(() => {
				this.bullseyeFrameRaf = null;
				this.isApplyingBullseyeFrame = false;
			});
		});
		this.scheduleOverlayUpdate();
	};

	setBullseyeViewActive = (isActive) => {
		const nextActive = Boolean(isActive);

		if (nextActive) {
			this.setState({
				isBullseyeViewActive: true,
			}, () => {
				this.applyChartInteractionLock(true);
				this.frameChartTo24hFocus();
			});
			return;
		}

		// EXIT: freeze time + price viewport BEFORE clearing the bullseye provider.
		// Clearing bullseyePriceRange while autoScale is still true rescales the chart.
		const priceScale = this.getMainPriceScale();
		const visibleRange = priceScale?.getVisibleRange?.();
		const logicalRange = this.chart?.timeScale()?.getVisibleLogicalRange?.();
		const scaleMargins = priceScale?.options?.()?.scaleMargins
			? { ...priceScale.options().scaleMargins }
			: null;
		const isLog = this.state.isLogPriceScale;
		const bullseyeRange = (
			this.bullseyePriceRange
			&& Number.isFinite(this.bullseyePriceRange.min)
			&& Number.isFinite(this.bullseyePriceRange.max)
			&& this.bullseyePriceRange.max > this.bullseyePriceRange.min
		)
			? { min: this.bullseyePriceRange.min, max: this.bullseyePriceRange.max }
			: null;

		let lockedLinearFrom = null;
		let lockedLinearTo = null;

		const visFrom = Number(visibleRange?.from);
		const visTo = Number(visibleRange?.to);

		if (
			Number.isFinite(visFrom)
			&& Number.isFinite(visTo)
			&& visTo !== visFrom
		) {
			lockedLinearFrom = Math.min(visFrom, visTo);
			lockedLinearTo = Math.max(visFrom, visTo);
			if (
				!this.lockMainPriceVisibleRange(lockedLinearFrom, lockedLinearTo, {
					isLog,
					syncMinMove: false,
					...(scaleMargins ? { scaleMargins } : {}),
				})
			) {
				priceScale?.applyOptions({ autoScale: false });
			}
		} else {
			priceScale?.applyOptions({ autoScale: false });
		}

		// Tick from the current span only — do not write setVisibleRange again.
		const tickMin = (
			lockedLinearFrom != null
			&& lockedLinearTo != null
			&& lockedLinearTo > lockedLinearFrom
		)
			? lockedLinearFrom
			: bullseyeRange?.min;
		const tickMax = (
			lockedLinearFrom != null
			&& lockedLinearTo != null
			&& lockedLinearTo > lockedLinearFrom
		)
			? lockedLinearTo
			: bullseyeRange?.max;

		if (Number.isFinite(tickMin) && Number.isFinite(tickMax) && tickMax > tickMin) {
			this.applyPriceScaleMinMoveForCurrentRange(tickMin, tickMax);
		}

		this.manualPriceRange = null;
		this.bullseyePriceRange = null;

		this.setState({
			isBullseyeViewActive: false,
			chartNotice: null,
		}, () => {
			this.applyChartInteractionLock(false);

			if (
				lockedLinearFrom != null
				&& lockedLinearTo != null
				&& lockedLinearTo > lockedLinearFrom
			) {
				this.lockMainPriceVisibleRange(lockedLinearFrom, lockedLinearTo, {
					isLog,
					syncMinMove: false,
					...(scaleMargins ? { scaleMargins } : {}),
				});
			}

			if (Number.isFinite(tickMin) && Number.isFinite(tickMax) && tickMax > tickMin) {
				this.applyPriceScaleMinMoveForCurrentRange(tickMin, tickMax);
			}

			if (
				logicalRange
				&& Number.isFinite(logicalRange.from)
				&& Number.isFinite(logicalRange.to)
			) {
				this.chart?.timeScale()?.setVisibleLogicalRange?.(logicalRange);
			}

			if (this.chartNoticeDebounceTimer) {
				window.clearTimeout(this.chartNoticeDebounceTimer);
				this.chartNoticeDebounceTimer = null;
			}

			if (this.chartNoticeHideTimer) {
				window.clearTimeout(this.chartNoticeHideTimer);
				this.chartNoticeHideTimer = null;
			}

			if (this.chartNoticeCloseTimer) {
				window.clearTimeout(this.chartNoticeCloseTimer);
				this.chartNoticeCloseTimer = null;
			}

			this.scheduleOverlayUpdate();
		});
	};

	toggleBullseyeView = () => {
		this.setBullseyeViewActive(!this.state.isBullseyeViewActive);
	};

	syncBullseyeViewIfActive = () => {
		if (this.state.isBullseyeViewActive) {
			this.frameChartTo24hFocus();
		}
	};

	getBookmarkedPriceForCurrency = (currency) => {
		const normalizedCurrency = String(currency || "").trim().toUpperCase();

		if (!normalizedCurrency) return null;

		if (this.state.appBookmarks && typeof this.state.appBookmarks === "object") {
			if (!Object.prototype.hasOwnProperty.call(this.state.appBookmarks, normalizedCurrency)) {
				return null;
			}

			return normalizeBookmarkPrice(this.state.appBookmarks[normalizedCurrency]);
		}

		return getBookmarkedPrice(normalizedCurrency);
	};

	getCachedAvgEntryPrice = (currency, avgEntries = this.state.appAvgEntries) => {
		const normalizedCurrency = String(currency || "").trim().toUpperCase();

		if (!normalizedCurrency || !avgEntries || typeof avgEntries !== "object") {
			return null;
		}

		const avgPrice = Number(avgEntries[normalizedCurrency]?.avgPrice);

		return Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : null;
	};

	getProfileBalanceForCurrency = (currency, profile = this.state.profile) => {
		const normalizedCurrency = String(currency || "").trim().toUpperCase();

		if (!normalizedCurrency) return null;

		const balances = Array.isArray(profile?.balances) ? profile.balances : [];

		return balances.find(item => (
			String(item?.currency || "").trim().toUpperCase() === normalizedCurrency
		)) || null;
	};

	hasMaterialAvgEntryBalance = (currency, state = this.state) => {
		const balance = this.getProfileBalanceForCurrency(currency, state.profile);

		if (!balance) return false;

		const value = this.getBalanceUsdValueForDisplay(balance, state);

		return Number.isFinite(value) && value >= AVG_ENTRY_MIN_USD;
	};

	getAvgEntryPriceForDisplay = (
		currency,
		state = this.state,
		avgEntries = state.appAvgEntries,
	) => {
		if (!this.hasMaterialAvgEntryBalance(currency, state)) {
			return null;
		}

		return this.getCachedAvgEntryPrice(currency, avgEntries);
	};

	syncAvgEntryPriceForDisplay = () => {
		const currency = String(this.state.baseCurrency || "").trim().toUpperCase();
		const nextPrice = this.getAvgEntryPriceForDisplay(currency);

		if (this.state.avgEntryPrice === nextPrice) return;

		this.setState({ avgEntryPrice: nextPrice }, this.scheduleOverlayUpdate);
	};

	getBalanceUsdValueForDisplay = (balance, state = this.state) => {
		const currency = String(balance?.currency || "").trim().toUpperCase();

		if (currency === "USD" || currency === "USDC") {
			return Number(balance?.total);
		}

		const baseCurrency = String(state.baseCurrency || "").trim().toUpperCase();
		const amount = Number(balance?.total);

		if (currency === baseCurrency) {
			const livePrice = Number(this.getOverlayMarketPrice(state));

			if (
				Number.isFinite(livePrice)
				&& livePrice > 0
				&& Number.isFinite(amount)
				&& amount > 0
			) {
				return amount * livePrice;
			}
		}

		return Number(balance?.usd_value);
	};

	getSellOrderCoinsUsdValue = (order, state = this.state) => {
		const currency = getCurrencyFromProductId(order?.product_id);
		const size = Number(getOrderDisplayAmount(order));

		if (!currency || !(size > 0)) return NaN;

		const avgPrice = this.getCachedAvgEntryPrice(currency, state.appAvgEntries);

		if (!Number.isFinite(avgPrice) || avgPrice <= 0) return NaN;

		return size * avgPrice;
	};

	/** Selected chart coin wallet size × live price (mark-to-market USD). */
	getSelectedCoinBagUsdNotional = (state = this.state) => {
		const currency = String(state.baseCurrency || "").trim().toUpperCase();

		if (!currency || currency === "USD" || currency === "USDC") {
			return null;
		}

		const balances = Array.isArray(state.profile?.balances) ? state.profile.balances : [];
		const match = balances.find(item => (
			String(item?.currency || "").trim().toUpperCase() === currency
		));
		const amount = Number(match?.total);
		const livePrice = Number(this.getOverlayMarketPrice(state));
		const candleClose = Number(state.candles?.[state.candles.length - 1]?.close);
		const price = (
			Number.isFinite(livePrice) && livePrice > 0
				? livePrice
				: candleClose
		);

		if (!(Number.isFinite(amount) && amount > 0 && Number.isFinite(price) && price > 0)) {
			return null;
		}

		return amount * price;
	};

	getProfileTotalUsdForDisplay = (state = this.state) => {
		const profile = state.profile;
		const apiTotal = Number(profile?.total_usd);
		const balances = Array.isArray(profile?.balances) ? profile.balances : [];
		const baseCurrency = String(state.baseCurrency || "").trim().toUpperCase();
		const livePrice = Number(this.getOverlayMarketPrice(state));

		if (!balances.length || !Number.isFinite(apiTotal)) {
			return apiTotal;
		}

		if (!Number.isFinite(livePrice) || livePrice <= 0) {
			return apiTotal;
		}

		const match = balances.find(item => (
			String(item?.currency || "").trim().toUpperCase() === baseCurrency
		));

		if (!match) return apiTotal;

		const amount = Number(match.total);
		const staleValue = Number(match.usd_value);

		if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(staleValue)) {
			return apiTotal;
		}

		const liveValue = amount * livePrice;

		return Number.isFinite(liveValue) ? apiTotal - staleValue + liveValue : apiTotal;
	};

	getBalanceBookmarkDelta = (balance) => {
		const currency = String(balance?.currency || "").trim().toUpperCase();

		if (!currency || currency === "USD" || currency === "USDC") return null;

		const bookmarkedPrice = this.getBookmarkedPriceForCurrency(currency);
		const avgPrice = this.getCachedAvgEntryPrice(currency);
		const referencePrice = (
			Number.isFinite(bookmarkedPrice) && bookmarkedPrice > 0
				? bookmarkedPrice
				: avgPrice
		);
		let currentPrice = Number(balance?.usd_price);
		const baseCurrency = String(this.state.baseCurrency || "").trim().toUpperCase();

		if (currency === baseCurrency) {
			const livePrice = Number(this.getOverlayMarketPrice());

			if (Number.isFinite(livePrice) && livePrice > 0) {
				currentPrice = livePrice;
			}
		} else if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
			currentPrice = NaN;
		}

		if (
			!Number.isFinite(referencePrice) ||
			referencePrice <= 0 ||
			!Number.isFinite(currentPrice) ||
			currentPrice <= 0
		) {
			return null;
		}

		const balanceAmount = Number(balance?.total);
		const deltaPerUnit = currentPrice - referencePrice;
		const deltaPercent = (deltaPerUnit / referencePrice) * 100;

		if (!Number.isFinite(deltaPercent)) return null;

		const hasAmount = Number.isFinite(balanceAmount) && balanceAmount > 0;
		const deltaUsd = hasAmount ? deltaPerUnit * balanceAmount : null;

		return {
			isPositive: deltaPercent >= 0,
			fromBookmark: Number.isFinite(bookmarkedPrice) && bookmarkedPrice > 0,
			label: Number.isFinite(deltaUsd)
				? `${formatSignedUsdCents(deltaUsd)} (${formatSignedPercent(deltaPercent)})`
				: formatSignedPercent(deltaPercent),
			percentLabel: formatSignedPercent(deltaPercent),
		};
	};

	applyAppState = (appState, change = null) => {
		const bookmarks = appState?.yzTrade?.bookmarks;
		const appBookmarks = bookmarks && typeof bookmarks === "object" && !Array.isArray(bookmarks)
			? Object.fromEntries(
				Object.entries(bookmarks)
					.map(([currency, price]) => [String(currency || "").toUpperCase(), normalizeBookmarkPrice(price)])
					.filter(([currency, price]) => currency && price !== null)
			)
			: {};
		const rawAvgEntries = appState?.yzTrade?.avgEntries;
		let appAvgEntries = rawAvgEntries && typeof rawAvgEntries === "object" && !Array.isArray(rawAvgEntries)
			? Object.fromEntries(
				Object.entries(rawAvgEntries)
					.map(([currency, entry]) => {
						const normalizedCurrency = String(currency || "").trim().toUpperCase();
						if (!normalizedCurrency || !entry || typeof entry !== "object") return null;

						const avgPrice = Number(entry.avgPrice);
						const qty = Number(entry.qty);
						const nullDate = String(entry.nullDate || "").trim() || null;

						return [
							normalizedCurrency,
							{
								nullDate,
								avgPrice: Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : null,
								qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
							},
						];
					})
					.filter(Boolean)
			)
			: {};

		// Live avg pushes land in change; merge so the chart updates even if state is briefly stale.
		if (
			change
			&& typeof change === "object"
			&& String(change.type || "") === "avg_entry_updated"
		) {
			const changeCurrency = String(change.currency || "").trim().toUpperCase();
			const changeAvg = Number(change.avg_price);
			const changeQty = Number(change.qty);

			if (changeCurrency) {
				appAvgEntries = {
					...appAvgEntries,
					[changeCurrency]: {
						nullDate: String(change.null_date || "").trim() || null,
						avgPrice: Number.isFinite(changeAvg) && changeAvg > 0 ? changeAvg : null,
						qty: Number.isFinite(changeQty) && changeQty > 0 ? changeQty : 0,
					},
				};
			}
		}

		const currency = this.state.baseCurrency;
		const bookmarkedPrice = this.getBookmarkedPriceForCurrency(currency);
		const cachedAvgEntryPrice = this.getAvgEntryPriceForDisplay(
			currency,
			{ ...this.state, appAvgEntries },
			appAvgEntries,
		);
		const settings = appState?.yzTrade?.settings;
		const balanceHistoryPeriod = normalizeBalanceHistoryPeriod(
			settings?.balanceHistoryPeriod,
			this.state.balanceHistoryPeriod,
		);
		const periodChanged = balanceHistoryPeriod !== this.state.balanceHistoryPeriod;
		const appSettings = settings && typeof settings === "object" && !Array.isArray(settings)
			? {
				balanceHistoryColored: Boolean(settings.balanceHistoryColored),
				balanceHistoryExpanded: Boolean(settings.balanceHistoryExpanded),
				balanceHistoryPeriod,
			}
			: this.state.appSettings;

		this.setState({
			appBookmarks,
			appAvgEntries,
			appSettings,
			bookmarkedPrice,
			avgEntryPrice: cachedAvgEntryPrice,
			...(periodChanged
				? {
					balanceHistoryPeriod,
					balanceHistoryLoading: true,
					balanceHistoryError: "",
				}
				: {}),
		}, () => {
			this.scheduleOverlayUpdate();

			if (periodChanged) {
				this.loadBalanceHistory(balanceHistoryPeriod);
			}
		});
	};

	updateAppSettings = (settings) => {
		this.setState(prev => ({
			appSettings: {
				...prev.appSettings,
				...settings,
			},
		}));

		api.updateAppSettings(settings).catch(() => {
			this.loadAppState();
		});
	};

	loadAppState = () => (
		api.getAppState().then(response => {
			this.applyAppState(response.data);
		}).catch(() => {
			this.setState({ appBookmarks: null, appAvgEntries: null });
		})
	);

	disconnectAppStateSocket = () => {
		this.isDisconnectingAppState = true;
		this.clearAppStateWatchdog();

		if (this.appStateReconnectTimer) {
			window.clearTimeout(this.appStateReconnectTimer);
			this.appStateReconnectTimer = null;
		}

		if (this.appStateSocket) {
			this.appStateSocket.onopen = null;
			this.appStateSocket.onmessage = null;
			this.appStateSocket.onerror = null;
			this.appStateSocket.onclose = null;
			this.appStateSocket.close();
			this.appStateSocket = null;
		}

		this.isDisconnectingAppState = false;
	};

	clearAppStateWatchdog = () => {
		if (this.appStateWatchdogTimer) {
			window.clearTimeout(this.appStateWatchdogTimer);
			this.appStateWatchdogTimer = null;
		}
	};

	markAppStateMessage = () => {
		this.lastAppStateMessageAt = Date.now();
		this.scheduleAppStateWatchdog();
	};

	scheduleAppStateWatchdog = () => {
		if (this.isDisconnectingAppState || !this.appStateSocket) return;

		this.clearAppStateWatchdog();
		this.appStateWatchdogTimer = window.setTimeout(() => {
			const socket = this.appStateSocket;
			const elapsed = Date.now() - this.lastAppStateMessageAt;

			if (!socket || this.isDisconnectingAppState) return;

			if (elapsed < APP_STATE_STALE_TIMEOUT_MS) {
				this.scheduleAppStateWatchdog();
				return;
			}

			socket.close();
		}, APP_STATE_STALE_TIMEOUT_MS);
	};

	scheduleAppStateReconnect = () => {
		if (this.isDisconnectingAppState || this.appStateReconnectTimer) return;

		const delays = [1000, 2000, 5000, 10000];
		const delay = delays[Math.min(this.appStateReconnectAttempt, delays.length - 1)];

		this.appStateReconnectAttempt += 1;
		this.appStateReconnectTimer = window.setTimeout(() => {
			this.appStateReconnectTimer = null;
			this.connectAppStateSocket();
		}, delay);
	};

	connectAppStateSocket = () => {
		if (this.appStateSocket) return;

		const socket = new WebSocket(`${getWebSocketBase()}/api/app-state/live`);
		this.appStateSocket = socket;
		this.lastAppStateMessageAt = Date.now();
		this.scheduleAppStateWatchdog();

		socket.onopen = () => {
			if (socket === this.appStateSocket) {
				this.appStateReconnectAttempt = 0;
				this.markAppStateMessage();
			}
		};

		socket.onmessage = (event) => {
			let message = null;

			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}

			if (socket !== this.appStateSocket) return;

			this.markAppStateMessage();

			if (message.type === "heartbeat") return;
			if (message.type !== "app_state") return;

			this.applyAppState(message.state, message.change);
		};

		socket.onerror = () => {
			if (socket === this.appStateSocket) {
				this.scheduleAppStateReconnect();
			}
		};

		socket.onclose = () => {
			if (socket === this.appStateSocket) {
				this.clearAppStateWatchdog();
				this.appStateSocket = null;
				this.scheduleAppStateReconnect();
			}
		};
	};

	disconnectLiveMarket = () => {
		this.isDisconnectingLive = true;
		this.clearTdRefreshTimers();
		this.stopOfficialCandlePoll();

		if (this.liveReconnectTimer) {
			window.clearTimeout(this.liveReconnectTimer);
			this.liveReconnectTimer = null;
		}

		this.rememberLiveCandleBucketTime(
			this.state.currentCandle?.time
			?? this.state.historicalCandles?.[this.state.historicalCandles.length - 1]?.time
		);
		this.marketSubscribeCount = 0;
		this.liveReconnectAttempt = 0;
		this.liveReconnectConfig = null;
		this.closeLiveSocketOnly();
		this.setState({ isLive: false });
		this.isDisconnectingLive = false;
	};

	closeLiveSocketOnly = () => {
		this.clearLiveWatchdog();
		this.clearLiveFlushTimer();
		this.pendingLiveTrades = [];
		this.pendingLiveDepth = null;

		if (this.liveConnectTimeout) {
			window.clearTimeout(this.liveConnectTimeout);
			this.liveConnectTimeout = null;
		}

		if (!this.liveSocket) {
			return;
		}

		const socket = this.liveSocket;
		this.liveSocket = null;
		this.liveProductId = null;
		this.liveTradesAfterAtMs = null;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;

		try {
			socket.close();
		} catch {
			// ignore close errors on dead sockets
		}
	};

	clearLiveWatchdog = () => {
		if (this.liveWatchdogTimer) {
			window.clearTimeout(this.liveWatchdogTimer);
			this.liveWatchdogTimer = null;
		}
	};

	markLiveMessage = () => {
		this.lastLiveMessageAt = Date.now();
		this.scheduleLiveWatchdog();
	};

	scheduleLiveWatchdog = () => {
		if (this.isDisconnectingLive || !this.liveSocket) return;

		this.clearLiveWatchdog();
		this.liveWatchdogTimer = window.setTimeout(() => {
			const socket = this.liveSocket;
			const elapsed = Date.now() - this.lastLiveMessageAt;

			if (!socket || this.isDisconnectingLive) return;

			if (elapsed < LIVE_STALE_TIMEOUT_MS) {
				this.scheduleLiveWatchdog();
				return;
			}

			socket.close();
		}, LIVE_STALE_TIMEOUT_MS);
	};

	scheduleLiveReconnect = () => {
		if (this.isDisconnectingLive || !this.liveReconnectConfig) return;

		if (this.liveReconnectTimer) {
			return;
		}

		const delays = [1000, 2000, 5000, 10000];
		const baseDelay = delays[Math.min(this.liveReconnectAttempt, delays.length - 1)];
		const jitter = Math.floor(Math.random() * 500);
		const delay = baseDelay + jitter;

		this.liveReconnectAttempt += 1;
		this.liveReconnectTimer = window.setTimeout(() => {
			const config = this.liveReconnectConfig;

			this.liveReconnectTimer = null;

			if (!config) return;

			this.openLiveSocket(config);
		}, delay);
	};

	connectLiveMarket = (productId, periodDays, periodGranularity, depth) => {
		this.disconnectLiveMarket();
		const depthRange = depth || this.pinnedMarketDepthRange;

		if (depthRange) {
			this.pinnedMarketDepthRange = depthRange;
		}

		this.liveReconnectConfig = { productId, periodDays, periodGranularity, depth: depthRange };
		this.liveReconnectAttempt = 0;
		this.openLiveSocket(this.liveReconnectConfig);
	};

	markLiveConnected = () => {
		this.liveReconnectAttempt = 0;
		this.setState(prev => ({
			isLive: true,
			error: prev.error === "Live stream connection failed." ? "" : prev.error,
		}));
	};

	openLiveSocket = ({ productId, periodDays, periodGranularity, depth }) => {
		this.closeLiveSocketOnly();

		const url = new URL(`${getWebSocketBase()}/api/live`);
		url.searchParams.set("product_id", productId);
		url.searchParams.set("days", String(periodDays));
		if (periodGranularity) {
			url.searchParams.set("granularity", String(periodGranularity));
		}

		if (Number.isFinite(Number(depth?.min_price))) {
			url.searchParams.set("min_price", String(depth.min_price));
		}

		if (Number.isFinite(Number(depth?.max_price))) {
			url.searchParams.set("max_price", String(depth.max_price));
		}

		const socket = new WebSocket(url.toString());
		this.liveSocket = socket;
		this.liveProductId = productId;
		this.lastLiveMessageAt = Date.now();
		this.scheduleLiveWatchdog();
		this.setState({ isLive: false });

		this.liveConnectTimeout = window.setTimeout(() => {
			if (socket !== this.liveSocket || socket.readyState === WebSocket.OPEN) {
				return;
			}

			socket.close();
		}, LIVE_CONNECT_TIMEOUT_MS);

		socket.onopen = () => {
			if (socket === this.liveSocket) {
				if (this.liveConnectTimeout) {
					window.clearTimeout(this.liveConnectTimeout);
					this.liveConnectTimeout = null;
				}

				this.liveReconnectAttempt = 0;
				this.scheduleLiveWatchdog();
			}
		};

		socket.onmessage = (event) => {
			let message = null;

			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}

			if (socket !== this.liveSocket) return;

			if (message.product_id && message.product_id !== this.liveProductId) return;

			if (message.type !== "orders_update") {
				this.markLiveMessage();
			}

			if (message.type === "subscribed") {
				if (message.stream === "market") {
					const cutoffMs = Date.parse(message.coinbase_time);

					if (Number.isFinite(cutoffMs)) {
						this.liveTradesAfterAtMs = cutoffMs;
					}

					this.markLiveConnected();
					this.marketSubscribeCount += 1;
					if (this.marketSubscribeCount > 1) {
						this.backfillCandlesAfterReconnect();
					}
				} else if (message.stream === "orders") {
					this.setState({ orderError: "" });
				}
			} else if (message.type === "trade") {
				this.markLiveConnected();
				this.queueLiveTrade(message);
			} else if (message.type === "orders_update") {
				this.applyLiveOrders(message);
			} else if (message.type === "depth_update") {
				this.queueLiveDepth(message);
			} else if (message.type === "heartbeat") {
				if (message.stream === "market" || message.stream === "connection") {
					this.markLiveConnected();
				}
			} else if (message.type === "order_stream_error") {
				this.setState({
					orderError: message.message || "Live order stream failed.",
				});
			} else if (message.type === "error") {
				this.rememberLiveCandleBucketTime(
					this.state.currentCandle?.time
					?? this.state.historicalCandles?.[this.state.historicalCandles.length - 1]?.time
				);
				this.setState({ isLive: false });
			}
		};

		socket.onerror = () => {
			if (socket !== this.liveSocket) return;

			this.setState({
				error: "Live stream connection failed.",
				isLive: false,
			});

			if (!this.isDisconnectingLive) {
				this.scheduleLiveReconnect();
			}
		};

		socket.onclose = () => {
			if (socket !== this.liveSocket) return;

			if (this.liveConnectTimeout) {
				window.clearTimeout(this.liveConnectTimeout);
				this.liveConnectTimeout = null;
			}

			this.clearLiveWatchdog();
			this.rememberLiveCandleBucketTime(
				this.state.currentCandle?.time
				?? this.state.historicalCandles?.[this.state.historicalCandles.length - 1]?.time
			);
			this.liveSocket = null;
			this.setState({ isLive: false });

			if (!this.isDisconnectingLive) {
				this.scheduleLiveReconnect();
			}
		};
	};

	clearLiveFlushTimer = () => {
		if (this.liveFlushTimer) {
			window.clearTimeout(this.liveFlushTimer);
			this.liveFlushTimer = null;
		}
	};

	queueLiveTrade = (message) => {
		this.pendingLiveTrades.push(message);
		this.scheduleLiveFlush();
	};

	queueLiveDepth = (message) => {
		this.pendingLiveDepth = message;
		this.scheduleLiveFlush();
	};

	scheduleLiveFlush = () => {
		if (this.liveFlushTimer) return;

		this.liveFlushTimer = window.setTimeout(this.flushLiveUpdates, 1000);
	};

	flushLiveUpdates = () => {
		this.liveFlushTimer = null;

		const trades = [...this.pendingLiveTrades]
			.sort((left, right) => Number(left.time) - Number(right.time));
		const depth = this.pendingLiveDepth;
		this.pendingLiveTrades = [];
		this.pendingLiveDepth = null;

		if (trades.length) {
			this.applyLiveTrades(trades, depth);
		} else if (depth) {
			this.applyLiveDepth(depth);
		}

		this.maybeSyncOfficialLiveCandles();

		if (this.pendingLiveTrades.length || this.pendingLiveDepth) {
			this.scheduleLiveFlush();
		}
	};

	applyLiveDepth = (message) => {
		const depth = message.depth;

		if (!depth || !Array.isArray(depth.bids) || !Array.isArray(depth.asks)) return;

		this.setState(prev => {
			if (!prev.depth) return null;

			const currentPrice = Number(depth.current_price);
			const minPrice = Number(
				this.pinnedMarketDepthRange?.min_price ?? prev.depth.min_price,
			);
			const maxPrice = Number(
				this.pinnedMarketDepthRange?.max_price ?? prev.depth.max_price,
			);
			const isInRange = level => {
				const price = Number(level.price);

				return Number.isFinite(price)
					&& (!Number.isFinite(minPrice) || price >= minPrice)
					&& (!Number.isFinite(maxPrice) || price <= maxPrice);
			};
			const bids = depth.bids.filter(isInRange);
			const asks = depth.asks.filter(isInRange);

			if (!bids.length && !asks.length) return null;

			return {
				depth: {
					...prev.depth,
					min_price: minPrice,
					max_price: maxPrice,
					current_price: Number.isFinite(currentPrice)
						? currentPrice
						: prev.depth.current_price,
					bids,
					asks,
				},
			};
		}, () => {
			this.scheduleOverlayUpdate();
			this.syncBullseyeViewIfActive();
		});
	};

	isDuplicateOrderEvent = (eventId) => {
		const normalizedEventId = String(eventId || "").trim();

		if (!normalizedEventId) return false;
		if (this.processedOrderEventIds.has(normalizedEventId)) return true;

		this.processedOrderEventIds.add(normalizedEventId);
		this.processedOrderEventIdQueue.push(normalizedEventId);

		if (this.processedOrderEventIdQueue.length > 100) {
			const expiredEventId = this.processedOrderEventIdQueue.shift();
			this.processedOrderEventIds.delete(expiredEventId);
		}

		return false;
	};

	applyLiveOrders = (message) => {
		const balanceGeneration = Number(message.balance_generation) || 0;
		this.latestBalanceGeneration = Math.max(
			this.latestBalanceGeneration,
			balanceGeneration,
		);

		// event_id is a hash of the Coinbase event states, not of all_orders: it may
		// only gate the balance refresh. all_orders is always merged.
		const isDuplicateEvent = this.isDuplicateOrderEvent(message.event_id);
		const incomingCount = Array.isArray(message.all_orders) ? message.all_orders.length : 0;
		console.log("[orders_update]", JSON.stringify({
			place: "applyLiveOrders.receive",
			event_id: message.event_id || null,
			product_id: message.product_id || null,
			snapshot: Boolean(message.snapshot),
			order_count: incomingCount,
			duplicate_event: isDuplicateEvent,
			balance_refresh_mode: message.balance_refresh_mode || null,
			refresh_balances: Boolean(message.refresh_balances),
		}));

		const refreshBalances = () => {
			if (isDuplicateEvent) return;
			const refreshMode = message.balance_refresh_mode;

			if (refreshMode === "immediate") {
				this.cancelPendingPartialFillBalanceRefresh();
				this.loadProfile({
					generation: balanceGeneration,
					forceAvgEntry: true,
				});
			} else if (refreshMode === "debounced") {
				this.schedulePartialFillBalanceRefresh(balanceGeneration);
			}

			this.loadAvgEntry({ force: true });
		};

		if (!Array.isArray(message.all_orders)) {
			console.log("[orders_update]", JSON.stringify({
				place: "applyLiveOrders.handle",
				case: "none_no_all_orders",
				duplicate_event: isDuplicateEvent,
			}));
			refreshBalances();
			return;
		}

		const incomingOrders = message.all_orders;
		this.lastOrdersSocketMergeAt = Date.now();
		this.restartAllOrdersRefreshTimer();
		let notices = [];
		let mergeCases = [];

		this.setState(prev => {
			const adopted = this.adoptIncomingOrders(
				prev.allOrders,
				incomingOrders,
				"applyLiveOrders.orders_update",
			);
			notices = adopted.notices;
			mergeCases = adopted.mergeCases || [];

			return {
				allOrders: adopted.allOrders,
				openOrderDrag: prev.openOrderDrag,
				orderError: "",
				allOrdersError: "",
			};
		}, () => {
			console.log("[orders_update]", JSON.stringify({
				place: "applyLiveOrders.handle",
				case: mergeCases.length ? "merge_rows" : "none",
				rows: mergeCases,
				notice_count: notices.length,
			}));
			this.showMergeNotices(notices);
			if (this.isOpenOrderPriceDragging) {
				this.schedulePriceOverlayUpdate();
			} else {
				this.scheduleOverlayUpdate();
			}
			refreshBalances();
		});
	};

	mergeOrderUpdates = (orders, updatedOrders) => {
		const ordersByKey = new Map();

		(Array.isArray(orders) ? orders : []).forEach(order => {
			if (
				order?.original_id
				&& isDisplayableOrderStatus(order.status)
			) {
				const key = getOrderIdentityKey(order);
				if (key) ordersByKey.set(key, enrichOrderForDisplay(order));
			}
		});

		updatedOrders.forEach(order => {
			if (!order?.original_id) return;

			const incomingKey = getOrderIdentityKey(order);
			const existing = incomingKey ? ordersByKey.get(incomingKey) : null;

			if (!isDisplayableOrderStatus(order.status)) {
				if (incomingKey) ordersByKey.delete(incomingKey);
				return;
			}

			const merged = mergeOrderFields(existing, order);
			const mergedKey = getOrderIdentityKey(merged) || incomingKey;
			if (mergedKey) ordersByKey.set(mergedKey, merged);
		});

		return uniqueOrdersByOriginalId(Array.from(ordersByKey.values()));
	};

	applyLiveTrades = (trades, depthMessage = null) => {
		if (!Array.isArray(trades) || !trades.length) return;

		const sortedTrades = [...trades].sort(
			(left, right) => Number(left.time) - Number(right.time),
		);
		let latestPrice = null;
		let marketVolume = 0;

		sortedTrades.forEach(trade => {
			const price = Number(trade?.price);
			const size = Number(trade?.size) || 0;
			const source = String(trade?.source || "");
			const isTicker = source === "ticker" || source === "ticker_batch";

			if (!Number.isFinite(price)) return;

			latestPrice = price;

			if (!isTicker && size > 0) {
				const tradeAtMs = Date.parse(trade?.trade_time);
				const cutoffMs = Number(this.liveTradesAfterAtMs);

				if (
					Number.isFinite(cutoffMs)
					&& Number.isFinite(tradeAtMs)
					&& tradeAtMs > cutoffMs
				) {
					marketVolume += size;
				}
			}
		});

		const current = this.state.currentCandle;
		const depth = this.buildDepthStateFromMessage(this.state, depthMessage, latestPrice);
		const nextDepth = depth
			? {
				...depth,
				current_price: Number.isFinite(latestPrice) ? latestPrice : depth.current_price,
			}
			: depth;

		if (!current || this.state.isLoading) {
			if (nextDepth !== this.state.depth) {
				this.setState({ depth: nextDepth }, this.scheduleOverlayUpdate);
			}
			this.syncBullseyeViewIfActive();
			return;
		}

		const currentHigh = Number(current.high);
		const currentLow = Number(current.low);
		const currentVolume = Number(current.volume);
		const liveCandle = {
			...current,
			high: Number.isFinite(latestPrice)
				? Math.max(Number.isFinite(currentHigh) ? currentHigh : latestPrice, latestPrice)
				: current.high,
			low: Number.isFinite(latestPrice)
				? Math.min(Number.isFinite(currentLow) ? currentLow : latestPrice, latestPrice)
				: current.low,
			close: Number.isFinite(latestPrice) ? latestPrice : current.close,
			volume: (Number.isFinite(currentVolume) ? currentVolume : 0) + marketVolume,
		};
		const candles = this.buildDisplayCandles(this.state.historicalCandles, liveCandle);
		const depthChanged = nextDepth !== this.state.depth;

		this.setState({
			...(depthChanged ? { depth: nextDepth } : {}),
			currentCandle: liveCandle,
			candles,
		}, () => {
			this.updateCurrentCandleOnChart(liveCandle);
			this.updateCurrentVwapPoint(liveCandle);
			this.schedulePriceOverlayUpdate();
			this.scheduleOverlayUpdate();
		});

		this.syncBullseyeViewIfActive();
	};

	refreshTdSequentialAfterClosedCandle = (newCandleTime) => {
		const boundary = Math.floor(Number(newCandleTime) / TD_TIMEFRAME_SECONDS) * TD_TIMEFRAME_SECONDS;

		if (!Number.isFinite(boundary) || boundary <= 0) return;
		if (this.lastTdRefreshBoundary === boundary) return;

		this.lastTdRefreshBoundary = boundary;
		this.scheduleTdSequentialRefreshRetries();
	};

	clearTdRefreshTimers = () => {
		this.tdRefreshTimers.forEach(timer => window.clearTimeout(timer));
		this.tdRefreshTimers = [];
	};

	scheduleTdSequentialRefreshRetries = () => {
		this.clearTdRefreshTimers();
		this.tdRefreshTimers = TD_REFRESH_RETRY_DELAYS.map(delay => (
			window.setTimeout(() => {
				this.refreshTdSequential();
			}, delay)
		));
	};

	refreshTdSequential = () => {
		const baseCurrency = this.state.baseCurrency.trim().toUpperCase();
		const periodDays = Number(this.state.loadedPeriodDays || this.state.periodDays) || DEFAULT_PERIOD_DAYS;

		if (!baseCurrency || this.tdRefreshInFlight) return;

		this.tdRefreshInFlight = true;

		api.getTdSequential({
			product_id: `${baseCurrency}-USD`,
			days: Math.max(periodDays, 28),
			_: Date.now(),
		}).then(response => {
			const tdSequential = response.data;

			this.setState({
				tdSequential,
				tdSequentialError: "",
			}, () => {
				this.syncTdSequentialSeries(tdSequential, this.state.candles);
				this.scheduleOverlayUpdate();
			});
		}).catch(error => {
			this.setState({
				tdSequentialError: error.response?.data?.detail || error.message || "Unable to refresh TD Sequential.",
			});
		}).finally(() => {
			this.tdRefreshInFlight = false;
		});
	};

	loadMarket = () => {
		const baseCurrency = this.state.baseCurrency.trim().toUpperCase();
		const periodDays = Number(this.state.periodDays) || DEFAULT_PERIOD_DAYS;
		const periodGranularity = this.state.periodGranularity ? Number(this.state.periodGranularity) : null;

		if (!baseCurrency) {
			this.setState({
				error: "Enter a base currency, for example BTC.",
				isLoading: false,
			});
			return;
		}

		const productId = `${baseCurrency}-USD`;
		this.syncCurrencyPath(baseCurrency);

		const requestId = ++this.marketRequestId;
		this.stopOfficialCandlePoll();
		this.isMarketTransitioning = true;
		const rangeSnapshot = this.getVisibleRangeSnapshot();
		const shouldPreserveRange =
			String(this.state.product?.product_id || "").toUpperCase() === productId
			&& periodDays === this.state.loadedPeriodDays
			&& periodGranularity === this.state.loadedPeriodGranularity
			&& Boolean(rangeSnapshot?.timeRange || rangeSnapshot?.logicalRange);

		this.setState({
			isLoading: true,
			isLoadingOlderCandles: false,
			hasMoreOlderCandles: true,
			error: "",
			isLive: false,
			orderError: "",
			candles: [],
			historicalCandles: [],
			currentCandle: null,
			depth: null,
			product: null,
			productStats: null,
			orderStats: null,
			tdSequential: null,
			tdSequentialError: "",
			hoveredVolumeIndex: null,
			freeCrosshairX: null,
			pointerPosition: null,
			bookmarkedPrice: this.getBookmarkedPriceForCurrency(baseCurrency),
			avgEntryPrice: this.getAvgEntryPriceForDisplay(baseCurrency),
		});
		this.disconnectLiveMarket();
		this.pinnedMarketDepthRange = null;
		this.cachedDistribution = null;
		this.cachedDistributionKey = null;
		this.candleSeries?.setData([]);
		this.plottedCandles = [];
		this.volumeSeries?.setData([]);
		this.cachedMacdPoints = [];
		this.cachedPvtPoints = [];
		this.syncVwapSeries([]);
		this.syncTdSequentialSeries(null, []);
		this.scheduleOverlayUpdate();

		api.getCandles({
			product_id: productId,
			days: periodDays,
			...(periodGranularity ? { granularity: periodGranularity } : {}),
		})
			.then((candlesResponse) => {
				if (requestId !== this.marketRequestId) return;

				const { candles: normalizedCandles } = this.parseCandlesResponse(
					candlesResponse.data,
				);

				if (!normalizedCandles.length) {
					throw new Error(`Coinbase returned no candle data for ${productId}.`);
				}

				const { historicalCandles, currentCandle } = this.splitCandlesFromApi(normalizedCandles);
				const candles = this.buildDisplayCandles(
					historicalCandles,
					currentCandle,
				);
				this.pinnedMarketDepthRange = this.getDepthRangeForCandles(candles);
				const depthRange = this.pinnedMarketDepthRange;

				this.lastOfficialCandleSyncAt = Math.floor(Date.now() / 1000);

				this.setState({
					candles,
					historicalCandles,
					currentCandle,
					baseCurrency,
					periodDays,
					periodGranularity,
					loadedPeriodDays: periodDays,
					loadedPeriodGranularity: periodGranularity,
					isLoading: false,
					bookmarkedPrice: this.getBookmarkedPriceForCurrency(baseCurrency),
				}, () => {
					if (requestId !== this.marketRequestId) return;

					this.rememberLiveCandleBucketTime(currentCandle?.time
						?? historicalCandles?.[historicalCandles.length - 1]?.time);

					if (!shouldPreserveRange) {
						this.getMainPriceScale()?.applyOptions({ autoScale: true });
					}

					this.candleSeries.setData(toChartData(candles));
					this.plottedCandles = candles;
					this.syncVolumeSeries(candles);
					this.syncMacdOverlay(candles);
					this.syncVwapSeries(candles);
					this.syncTdSequentialSeries(null, candles);
					this.handleResize();

					// !IMPORTANT DO NOT TOUCH. DO NOT OPTIMIZE UNLESS REQUESTED BY USER.
					this.armLogPriceScaleResyncAfterData();

					const didRestoreView = shouldPreserveRange
						? this.restoreVisibleRange(rangeSnapshot)
						: false;

					if (!didRestoreView) {
						this.applyDefaultVisibleRange(candles);
					}

					// !IMPORTANT DO NOT TOUCH. DO NOT OPTIMIZE UNLESS REQUESTED BY USER.
					// Range restore/default should fire the logical-range event; if not, apply now.
					this.applyPendingLogPriceScaleResync();
					this.syncPriceScaleMinMoveFromViewport();

					this.syncCurrencyPath(baseCurrency);
					this.loadProductStats(productId);
					this.connectLiveMarket(productId, periodDays, periodGranularity, depthRange);
					this.isMarketTransitioning = false;
					this.scheduleOverlayUpdate();
					this.loadAvgEntry();
					this.loadMarketDetails({
						requestId,
						productId,
						periodDays,
						depthRange,
					});
				});
			})
			.catch(error => {
				if (requestId !== this.marketRequestId) return;

				this.isMarketTransitioning = false;
				const detail = error.response?.data?.detail || error.message || "Unable to load market data.";
				const errorText = typeof detail === "string" && detail.includes("NotFound")
					? "Wrong parameters"
					: detail;

				this.setState({
					error: errorText,
					candles: [],
					historicalCandles: [],
					currentCandle: null,
					depth: null,
					orderStats: null,
					tdSequential: null,
					tdSequentialError: "",
					isLoading: false,
				}, () => {
					this.syncTdSequentialSeries(null);
				});
			});
	};

	loadMarketDetails = ({ requestId, productId, periodDays, depthRange }) => {
		api.getProduct(productId).then(productResponse => {
			if (requestId !== this.marketRequestId) return;

			this.setState({
				product: productResponse.data,
			}, () => {
				this.applyPriceSeriesFormat();
				this.scheduleOverlayUpdate();
			});
		}).catch(() => {});

		api.getDepth({
			product_id: productId,
			min_price: depthRange.min_price,
			max_price: depthRange.max_price,
		}).then(depthResponse => {
			if (requestId !== this.marketRequestId) return;

			this.setState({
				depth: {
					...depthResponse.data,
					min_price: this.pinnedMarketDepthRange?.min_price ?? depthRange.min_price,
					max_price: this.pinnedMarketDepthRange?.max_price ?? depthRange.max_price,
				},
			}, this.scheduleOverlayUpdate);
		}).catch(() => {});

		api.getOrders({
			product_id: productId,
			all_products: true,
			_: Date.now(),
		}).then(ordersResponse => {
			if (requestId !== this.marketRequestId) return;

			const fetched = Array.isArray(ordersResponse.data?.orders)
				? ordersResponse.data.orders
				: [];
			this.setState(prev => {
				const adopted = this.adoptIncomingOrders(
					prev.allOrders,
					fetched,
					"loadMarket.orders",
				);
				const chartOrders = this.getChartOrders(adopted.allOrders);

				return {
					allOrders: adopted.allOrders,
					orderStats: {
						openTotal: ordersResponse.data?.open_total,
						applicableTotal: chartOrders.length,
						drawableTotal: chartOrders.length,
						skippedTotal: ordersResponse.data?.skipped_total,
					},
					orderError: "",
				};
			}, this.scheduleOverlayUpdate);
		}).catch(error => {
			if (requestId !== this.marketRequestId) return;

			this.setState({
				orderStats: null,
				orderError: error.response?.data?.detail || error.message || "Unable to load Coinbase orders.",
			});
		});

		api.getTdSequential({
			product_id: productId,
			days: Math.max(periodDays, 28),
			_: Date.now(),
		}).then(tdResponse => {
			if (requestId !== this.marketRequestId) return;

			const tdSequential = tdResponse.data;

			this.setState({
				tdSequential,
				tdSequentialError: "",
			}, () => {
				this.syncTdSequentialSeries(tdSequential, this.state.candles);
				this.scheduleOverlayUpdate();
			});
		}).catch(error => {
			if (requestId !== this.marketRequestId) return;

			this.setState({
				tdSequential: null,
				tdSequentialError: error.response?.data?.detail || error.message || "Unable to load TD Sequential.",
			});
		});
	};

	handleProductSubmit = (event) => {
		event.preventDefault();
		const baseCurrency = (
			this.state.isMonitorFiltering
				? this.state.monitorQuery
				: this.state.baseCurrency
		).trim().toUpperCase();

		this.setState({
			baseCurrency,
			isMonitorFiltering: false,
			monitorQuery: "",
		}, () => {
			this.loadMarket();
			this.loadProfile();
		});
	};

	loadMonitorTickers = () => {
		api.getMonitorTickers().then(response => {
			this.setState({
				monitorTickers: Array.isArray(response.data?.tickers)
					? response.data.tickers
					: this.state.monitorTickers,
				monitorError: "",
			});
		}).catch(error => {
			this.setState({
				monitorError: error.response?.data?.detail || error.message || "Unable to load monitor tickers.",
			});
		});
	};

	loadProductStats = (productId = null) => {
		const baseCurrency = String(this.state.baseCurrency || "").trim().toUpperCase();
		const activeProductId = productId || (baseCurrency ? `${baseCurrency}-USD` : "");

		if (!activeProductId || this.state.isLoading) return;

		api.getProductStats(activeProductId).then(response => {
			if (String(response.data?.product_id || "").toUpperCase() !== activeProductId.toUpperCase()) return;

			this.setState({
				productStats: response.data,
			});
		}).catch(() => {});
	};

	handleMonitorTickerClick = (baseCurrency) => {
		const normalizedBaseCurrency = String(baseCurrency || "").toUpperCase();

		if (!normalizedBaseCurrency) return;

		this.setState({
			baseCurrency: normalizedBaseCurrency,
			isMonitorOpen: false,
			isMonitorFiltering: false,
			monitorQuery: "",
		}, this.loadMarket);
	};

	openMonitorDropdown = () => {
		this.loadMonitorTickers();

		if (!this.state.isMonitorOpen) {
			this.setAnimatedDropdown("monitor", true);
		}
	};

	toggleMonitorDropdown = () => {
		const willOpen = !this.state.isMonitorOpen;

		if (willOpen) {
			this.loadMonitorTickers();
		}

		this.setAnimatedDropdown("monitor", willOpen);
	};

	handleMonitorTickerLinkClick = (event, baseCurrency) => {
		if (
			event.button !== 0
			|| event.metaKey
			|| event.ctrlKey
			|| event.shiftKey
			|| event.altKey
		) {
			return;
		}

		event.preventDefault();
		this.handleMonitorTickerClick(baseCurrency);
	};

	handleCurrencyNavigationLinkClick = (event, baseCurrency, source) => {
		if (
			event.defaultPrevented
			|| event.button !== 0
			|| event.metaKey
			|| event.ctrlKey
			|| event.shiftKey
			|| event.altKey
		) {
			return;
		}

		event.preventDefault();

		if (source === "orders") {
			this.handleOrdersCurrencyClick(baseCurrency);
		} else {
			this.handleProfileCurrencyClick(baseCurrency);
		}
	};

	clearAvgEntryRetry = () => {
		if (this.avgEntryRetryTimer) {
			window.clearTimeout(this.avgEntryRetryTimer);
			this.avgEntryRetryTimer = null;
		}

		this.avgEntryRetryAttempt = 0;
	};

	scheduleAvgEntryRetry = (options = {}) => {
		if (this.avgEntryRetryAttempt >= AVG_ENTRY_RETRY_MAX_ATTEMPTS) {
			this.clearAvgEntryRetry();
			return;
		}

		const attempt = this.avgEntryRetryAttempt;
		const delay = Math.min(
			AVG_ENTRY_RETRY_MAX_MS,
			AVG_ENTRY_RETRY_BASE_MS * (2 ** attempt),
		);

		this.avgEntryRetryAttempt = attempt + 1;

		if (this.avgEntryRetryTimer) {
			window.clearTimeout(this.avgEntryRetryTimer);
		}

		this.avgEntryRetryTimer = window.setTimeout(() => {
			this.avgEntryRetryTimer = null;
			this.loadAvgEntry({
				...options,
				isRetry: true,
			});
		}, delay);
	};

	loadAvgEntry = (options = {}) => {
		const currency = String(this.state.baseCurrency || "").trim().toUpperCase();
		const force = Boolean(options.force);
		const isRetry = Boolean(options.isRetry);

		if (!isRetry) {
			if (this.avgEntryRetryTimer) {
				window.clearTimeout(this.avgEntryRetryTimer);
				this.avgEntryRetryTimer = null;
			}

			this.avgEntryRetryAttempt = 0;
		}

		if (!currency || currency === "USD" || currency === "USDC") {
			this.clearAvgEntryRetry();

			if (this.state.avgEntryPrice !== null) {
				this.setState({ avgEntryPrice: null }, this.scheduleOverlayUpdate);
			}
			return;
		}

		const cachedPrice = this.getAvgEntryPriceForDisplay(currency);
		if (!force && cachedPrice !== null && this.state.avgEntryPrice !== cachedPrice) {
			this.setState({ avgEntryPrice: cachedPrice }, this.scheduleOverlayUpdate);
		} else if (!force && cachedPrice === null && this.state.avgEntryPrice !== null) {
			this.setState({ avgEntryPrice: null }, this.scheduleOverlayUpdate);
		}

		const requestId = ++this.avgEntryRequestId;

		api.getAvgEntry(currency, force ? { force: true } : undefined)
			.then((response) => {
				if (requestId !== this.avgEntryRequestId) return;
				if (String(this.state.baseCurrency || "").trim().toUpperCase() !== currency) return;

				this.clearAvgEntryRetry();

				const avgPrice = Number(response.data?.avg_price);
				const tracked = Boolean(response.data?.tracked);
				const reason = String(response.data?.reason || "");
				const isDust = reason === "dust";
				const computedPrice = tracked && Number.isFinite(avgPrice) && avgPrice > 0
					? avgPrice
					: null;

				this.setState(prev => {
					const nextAvgEntries = { ...(prev.appAvgEntries || {}) };
					const prevEntry = nextAvgEntries[currency] || {};
					const prevCached = Number(prevEntry.avgPrice);
					const prevCachedPrice = Number.isFinite(prevCached) && prevCached > 0
						? prevCached
						: null;
					const responseQty = Number(response.data?.qty);
					const responseQtyValue = Number.isFinite(responseQty) && responseQty > 0
						? responseQty
						: 0;
					// On order/fill force refresh: only clear avg for dust.
					// Failed recompute must not blank the line or wipe local avgEntries.
					const rawNextPrice = computedPrice !== null
						? computedPrice
						: (isDust ? null : prevCachedPrice);
					const nextPrice = (
						rawNextPrice !== null && this.hasMaterialAvgEntryBalance(currency, prev)
					)
						? rawNextPrice
						: null;

					if (isDust) {
						nextAvgEntries[currency] = {
							nullDate: response.data?.null_date || null,
							avgPrice: null,
							qty: 0,
						};
					} else {
						nextAvgEntries[currency] = {
							nullDate: response.data?.null_date || prevEntry.nullDate || null,
							avgPrice: computedPrice !== null
								? computedPrice
								: (prevEntry.avgPrice ?? null),
							qty: responseQtyValue > 0
								? responseQtyValue
								: (Number(prevEntry.qty) || 0),
						};
					}

					const nextState = {
						appAvgEntries: nextAvgEntries,
					};

					if (prev.avgEntryPrice !== nextPrice) {
						nextState.avgEntryPrice = nextPrice;
					}

					return nextState;
				}, this.scheduleOverlayUpdate);
			})
			.catch(() => {
				if (requestId !== this.avgEntryRequestId) return;
				if (String(this.state.baseCurrency || "").trim().toUpperCase() !== currency) return;

				if (!force) {
					const fallbackPrice = this.getAvgEntryPriceForDisplay(currency);

					this.setState(prev => (
						prev.avgEntryPrice === fallbackPrice
							? null
							: { avgEntryPrice: fallbackPrice }
					), this.scheduleOverlayUpdate);
				}

				// Always retry failed loads (including force) so a blank chart recovers.
				this.scheduleAvgEntryRetry({ force, isRetry: true });
			});
	};

	loadProfile = (options = {}) => {
		const requestedGeneration = Number(options.generation) || 0;
		const generation = Math.max(
			requestedGeneration,
			this.latestBalanceGeneration,
		);
		const forcePrices = Boolean(options.forcePrices);
		const forceAvgEntry = Boolean(options.forceAvgEntry) || forcePrices;
		const requestKey = `${generation}:${forcePrices ? "force" : "cached"}`;
		const activeRequest = this.profileLoadPromises.get(requestKey);

		if (activeRequest) return activeRequest;

		this.setState({
			isProfileLoading: !this.state.profile,
			profileError: "",
		});

		const request = api.getBalances(generation, { forcePrices }).then(response => {
			const profile = response.data;
			const responseGeneration = Number(profile?.generation) || 0;
			this.latestBalanceGeneration = Math.max(
				this.latestBalanceGeneration,
				responseGeneration,
			);

			if (responseGeneration < this.latestBalanceGeneration) {
				return null;
			}

			this.setState({
				profile,
				profileError: "",
				isProfileLoading: false,
			}, () => {
				this.scheduleOverlayUpdate();
				this.syncAvgEntryPriceForDisplay();
				this.loadAvgEntry(forceAvgEntry ? { force: true } : undefined);
			});

			return profile;
		}).catch(error => {
			if (generation < this.latestBalanceGeneration) return null;

			this.setState({
				profileError: error.response?.data?.detail || error.message || "Unable to load Coinbase balances.",
				isProfileLoading: false,
			});

			return null;
		}).finally(() => {
			if (this.profileLoadPromises.get(requestKey) === request) {
				this.profileLoadPromises.delete(requestKey);
			}
		});

		this.profileLoadPromises.set(requestKey, request);
		return request;
	};

	cancelPendingPartialFillBalanceRefresh = () => {
		if (this.partialFillBalanceRefreshTimer) {
			window.clearTimeout(this.partialFillBalanceRefreshTimer);
			this.partialFillBalanceRefreshTimer = null;
		}

		this.pendingPartialFillBalanceGeneration = 0;
	};

	schedulePartialFillBalanceRefresh = (generation) => {
		this.pendingPartialFillBalanceGeneration = Math.max(
			this.pendingPartialFillBalanceGeneration,
			Number(generation) || 0,
		);

		if (this.partialFillBalanceRefreshTimer) {
			window.clearTimeout(this.partialFillBalanceRefreshTimer);
		}

		this.partialFillBalanceRefreshTimer = window.setTimeout(() => {
			this.partialFillBalanceRefreshTimer = null;
			const pendingGeneration = this.pendingPartialFillBalanceGeneration;
			this.pendingPartialFillBalanceGeneration = 0;
			this.loadProfile({
				generation: pendingGeneration,
			});
		}, PARTIAL_FILL_BALANCE_DEBOUNCE_MS);
	};

	getChartOrders = (allOrders = this.state.allOrders) => {
		const productId = `${this.state.baseCurrency.trim().toUpperCase()}-USD`;

		return filterOrdersForChartProduct(
			uniqueOrdersByOriginalId(Array.isArray(allOrders) ? allOrders : [])
				.filter(order => String(order?.order_type || "").toUpperCase() !== "MARKET"),
			productId,
		);
	};

	logChartOrderLine = (action, place, order, extra = null) => {
		const payload = {
			action,
			place,
			orderId: String(order?.originalId || order?.original_id || ""),
			originalId: String(order?.originalId || order?.original_id || ""),
			role: order?.role || "limit",
			price: Number(order?.price),
			...(extra && typeof extra === "object" ? extra : {}),
		};

		// console.log("[chart-order-line]", JSON.stringify(payload));
		void payload;
	};

	setOrderLineDisplayPlace = (place) => {
		this.orderLineDisplayPlace = place || "renderOverlay";
	};

	noteDragOwnerIfChanged = (place, nextDrag, prevDrag = this.state.openOrderDrag) => {
		const fromId = String(prevDrag?.orderId || "").trim();
		const toId = nextDrag == null ? "" : String(nextDrag.orderId || "").trim();
		if (fromId === toId) return;

		// console.log("[order-drag]", JSON.stringify({
		// 	place,
		// 	original_id: toId || null,
		// 	previous_id: fromId || null,
		// }));
		void place;
	};

	logChartOrderDisplayIfChanged = (orderLines) => {
		const next = new Map();

		(Array.isArray(orderLines) ? orderLines : []).forEach(line => {
			const originalId = String(line?.original_id || "").trim();
			if (!originalId) return;

			const role = String(line?.role || "limit").toLowerCase() || "limit";
			const price = Number(line?.price);
			const pollsAfterMove = Number(line?.pollsAfterMove);

			next.set(`${originalId}:${role}`, {
				original_id: originalId,
				pollsAfterMove: Number.isFinite(pollsAfterMove) ? pollsAfterMove : null,
				price,
			});
		});

		const prev = this.chartOrderDisplayByKey;
		const place = this.orderLineDisplayPlace || "renderOverlay";

		next.forEach((row, key) => {
			const before = prev.get(key);
			if (before && before.price === row.price) return;

			// console.log("[order-line-display]", JSON.stringify({
			// 	place,
			// 	original_id: row.original_id,
			// 	pollsAfterMove: row.pollsAfterMove,
			// 	price: row.price,
			// 	...(before ? { fromPrice: before.price } : { added: true }),
			// }));
			void place;
			void row;
			void before;
		});

		prev.forEach((row, key) => {
			if (next.has(key)) return;

			// console.log("[order-line-display]", JSON.stringify({
			// 	place,
			// 	original_id: row.original_id,
			// 	pollsAfterMove: row.pollsAfterMove,
			// 	price: row.price,
			// 	removed: true,
			// }));
			void row;
		});

		this.chartOrderDisplayByKey = next;
	};

	getChartOrderLineSnapshot = (allOrders) => {
		const lines = new Map();

		this.getChartOrders(allOrders)
			.filter(order => isDisplayableOrderStatus(order?.status))
			.forEach((order) => {
				const expanded = (
					Array.isArray(order.bracket_legs) && order.bracket_legs.length
						? order.bracket_legs.map(leg => ({
							...order,
							...leg,
							original_id: order.original_id,
						}))
						: [order]
				);

				expanded.forEach((line) => {
					const role = String(line?.role || "limit").toLowerCase() || "limit";
					const identity = getOrderIdentityKey(line) || String(line?.id || "");
					if (!identity) return;

					const price = Number(line?.price);
					if (!Number.isFinite(price) || price <= 0) return;

					lines.set(`${identity}:${role}`, {
						orderId: String(line?.original_id || ""),
						originalId: String(line?.original_id || ""),
						role,
						price,
						status: line?.status,
					});
				});
			});

		return lines;
	};

	diffChartOrderLines = (prevAllOrders, nextAllOrders, place) => {
		const prev = this.getChartOrderLineSnapshot(prevAllOrders);
		const next = this.getChartOrderLineSnapshot(nextAllOrders);

		prev.forEach((prevLine, key) => {
			const nextLine = next.get(key);

			if (!nextLine) {
				this.logChartOrderLine("remove", place, prevLine, {
					removedPrice: prevLine.price,
				});
				return;
			}

			if (prevLine.price !== nextLine.price) {
				this.logChartOrderLine("move", place, nextLine, {
					fromPrice: prevLine.price,
					toPrice: nextLine.price,
				});
			}
		});
	};

	/** Confirmed USD on a row: ORIGINAL / order total / quote — never invent from bad size×price. */
	getOrderConfirmedUsdNotional = (order) => {
		if (!order || typeof order !== "object") return null;

		for (const candidate of [
			order.original_value_usd,
			order.order_total,
			order.total_value,
			order.quote_size,
		]) {
			const value = Number(candidate);
			if (Number.isFinite(value) && value > 0) return value;
		}

		return null;
	};

	/** Live $ while dragging: SELL/TP/SL = size × price; BUY limit = frozen confirmed $. */
	getLiveDragNotionalUsd = (size, price) => {
		const qty = Number(size);
		const value = Number(price);

		if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(value) || value <= 0) {
			return null;
		}

		return qty * value;
	};

	getDragDisplayNotionalUsd = (drag, order = null) => {
		if (!drag) return null;

		const kind = String(drag.kind || "limit").toLowerCase();
		const side = String(drag.side || order?.side || "").toUpperCase();
		const isBuyLimit = kind === "limit" && side === "BUY";

		if (isBuyLimit) {
			const frozen = Number(drag.confirmedUsd);
			if (Number.isFinite(frozen) && frozen > 0) return frozen;
			return this.getOrderConfirmedUsdNotional(order);
		}

		return this.getLiveDragNotionalUsd(drag.size, order?.price);
	};

	/** Orders list rows from allOrders only. */
	getOrdersForListDisplay = (orders = this.state.allOrders) => (
		Array.isArray(orders) ? orders : []
	);

	restartAllOrdersRefreshTimer = () => {
		if (this.allOrdersRefreshTimer) {
			window.clearInterval(this.allOrdersRefreshTimer);
		}
		this.allOrdersRefreshTimer = window.setInterval(this.loadAllOrders, ALL_ORDERS_REFRESH_INTERVAL_MS);
	};

	loadAllOrders = (options = {}) => {
		// Only one orders refresh at a time.
		if (this.allOrdersRequest) return this.allOrdersRequest;

		const baseCurrency = this.state.baseCurrency.trim().toUpperCase();
		const productId = `${baseCurrency}-USD`;

		this.setState({
			isOrdersLoading: !this.state.allOrders.length,
			allOrdersError: "",
		});

		const params = {
			product_id: productId,
			all_products: true,
			_: Date.now(),
		};

		if (options.force) {
			params.force = true;
		}

		const sentAt = Date.now();

		this.allOrdersRequest = api.getOrders(params).then(response => {
			this.allOrdersRequest = null;

			// A socket orders_update merged after this poll was sent is newer than its response.
			if (this.lastOrdersSocketMergeAt > sentAt) {
				this.setState({ isOrdersLoading: false });
				return;
			}

			const fetchedOrders = Array.isArray(response.data?.orders)
				? response.data.orders
				: [];
			const replaceLocal = Boolean(options.replaceLocal);
			let notices = [];

			this.setState(prev => {
				const adopted = this.adoptIncomingOrders(
					prev.allOrders,
					fetchedOrders,
					replaceLocal ? "loadAllOrders.replaceLocal" : "loadAllOrders.reconcile",
				);
				notices = adopted.notices;
				const chartOrders = this.getChartOrders(adopted.allOrders);

				if (replaceLocal) {
					this.isOpenOrderPriceDragging = false;
					this.openOrderPriceDragGrabOffsetY = 0;
					this.openOrderDragFrozenTotals = null;
					this.openOrderDragFrozenLimitTotal = null;
					this.releaseOpenOrderPointerCapture();
				}

				const nextDrag = replaceLocal ? null : prev.openOrderDrag;
				if (replaceLocal) {
					this.noteDragOwnerIfChanged("loadAllOrders.replaceLocal", nextDrag, prev.openOrderDrag);
				}

				return {
					allOrders: adopted.allOrders,
					openOrderDrag: nextDrag,
					orderStats: {
						openTotal: response.data?.open_total,
						applicableTotal: chartOrders.length,
						drawableTotal: chartOrders.length,
						skippedTotal: response.data?.skipped_total,
					},
					allOrdersError: "",
					orderError: "",
					isOrdersLoading: false,
				};
			}, () => {
				this.showMergeNotices(notices);
				if (this.isOpenOrderPriceDragging) {
					this.schedulePriceOverlayUpdate();
				} else {
					this.scheduleOverlayUpdate();
				}
			});
		}).catch(error => {
			this.allOrdersRequest = null;
			this.setState({
				allOrdersError: error.response?.data?.detail || error.message || "Unable to load Coinbase orders.",
				isOrdersLoading: false,
			});
		});

		return this.allOrdersRequest;
	};

	forceRefreshAccount = () => {
		if (this.state.isAccountRefreshing) return;

		this.isOpenOrderPriceDragging = false;
		this.openOrderPriceDragGrabOffsetY = 0;
		this.openOrderDragFrozenTotals = null;
		this.openOrderDragFrozenLimitTotal = null;
		this.releaseOpenOrderPointerCapture();
		this.setOrderLineDisplayPlace("forceRefreshAccount");
		this.noteDragOwnerIfChanged("forceRefreshAccount", null);
		this.setState({ isAccountRefreshing: true, openOrderDrag: null });

		Promise.allSettled([
			this.loadAllOrders({ force: true, replaceLocal: true }),
			this.loadProfile({ forcePrices: true, forceAvgEntry: true }),
			this.refreshDepthRangeFromFirstLoad(),
		]).finally(() => {
			this.setState({ isAccountRefreshing: false });
		});
	};

	refreshBalancesManually = (reason) => {
		if (this.state.isBalanceRefreshing) return;

		this.setState({ isBalanceRefreshing: true });
		this.loadProfile({ reason, forcePrices: true }).finally(() => {
			this.setState({ isBalanceRefreshing: false });
		});
	};

	refreshOrderTicketBalance = () => {
		this.refreshBalancesManually("order_overlay_manual_refresh");
	};

	refreshBalanceDropdown = () => {
		this.refreshBalancesManually("balance_dropdown_manual_refresh");
	};

	handleProfileCurrencyClick = (currency) => {
		const baseCurrency = String(currency || "").trim().toUpperCase();

		if (!baseCurrency || baseCurrency === "USD" || baseCurrency === "USDC") return;

		this.setState({
			baseCurrency,
			isProfileOpen: false,
			isOrdersOpen: false,
			isMonitorFiltering: false,
			monitorQuery: "",
		}, this.loadMarket);
	};

	handleOrdersCurrencyClick = (currency) => {
		const baseCurrency = String(currency || "").trim().toUpperCase();

		if (!baseCurrency || baseCurrency === "USD" || baseCurrency === "USDC" || baseCurrency === "UNKNOWN") return;

		this.setState({
			baseCurrency,
			isProfileOpen: false,
			isOrdersOpen: false,
			isMonitorFiltering: false,
			monitorQuery: "",
		}, this.loadMarket);
	};

	getAvailableBalanceForSide = (side = this.state.orderTicket?.side, profile = this.state.profile) => {
		const balances = Array.isArray(profile?.balances) ? profile.balances : [];
		const normalizedSide = side === "SELL" ? "SELL" : "BUY";

		if (normalizedSide === "SELL") {
			const baseCurrency = this.state.baseCurrency.toUpperCase();
			const balance = balances.find(item => item.currency === baseCurrency);

			return {
				currency: baseCurrency,
				amount: Number(balance?.available) || 0,
			};
		}

		const quote = this.getBuyQuoteBalance(profile);

		return {
			currency: quote.currency,
			amount: quote.amount,
		};
	};

	getDisplayedBalanceForSide = (side = this.state.orderTicket?.side) => {
		const balances = Array.isArray(this.state.profile?.balances) ? this.state.profile.balances : [];
		const normalizedSide = side === "SELL" ? "SELL" : "BUY";

		if (normalizedSide === "SELL") {
			const baseCurrency = this.state.baseCurrency.toUpperCase();
			const balance = balances.find(item => item.currency === baseCurrency);
			const available = Number(balance?.available);

			return {
				currency: baseCurrency,
				amount: Number.isFinite(available) ? available : 0,
			};
		}

		const usdc = balances.find(item => item.currency === "USDC");
		const usdcAvailable = Number(usdc?.available);

		return {
			currency: "USDC",
			amount: Number.isFinite(usdcAvailable) ? usdcAvailable : 0,
		};
	};

	getBuyQuoteBalance = (profile = this.state.profile) => {
		const balances = Array.isArray(profile?.balances) ? profile.balances : [];
		const usdc = balances.find(item => item.currency === "USDC");

		return {
			currency: "USDC",
			amount: Number(usdc?.available) || 0,
		};
	};

	getOrderPriceInputValue = (price) => {
		const formatted = formatPriceWithIncrement(price, this.state.product?.quote_increment);

		return formatted === "--" ? "0" : formatted;
	};

	getBaseAmountInputValue = (amount) => {
		const formatted = formatAmountWithIncrementFloor(amount, this.state.product?.base_increment);

		return formatted === "--" ? "0" : formatted;
	};

	getOrderAmountInputValue = (ticket, amount) => {
		const numericAmount = Number(amount);

		if (!Number.isFinite(numericAmount)) return "0";

		return ticket?.amountMode === "USD"
			? formatUsdAmountInput(numericAmount)
			: this.getBaseAmountInputValue(numericAmount);
	};

	clampOrderTicketAmount = (ticket) => {
		if (!ticket) return ticket;

		const amount = Number(ticket.amount);
		const maxAmount = this.getOrderMaxAmount(ticket);
		const safeMaxAmount = Number.isFinite(maxAmount) && maxAmount > 0 ? maxAmount : 0;
		const clampedAmount = Number.isFinite(amount)
			? Math.max(0, Math.min(amount, safeMaxAmount))
			: 0;
		const formattedAmount = this.getOrderAmountInputValue(ticket, clampedAmount);
		const nextTicket = {
			...ticket,
			amount: formattedAmount,
		};

		return {
			...nextTicket,
			fraction: safeMaxAmount > 0
				? Math.max(0, Math.min(1, clampedAmount / safeMaxAmount))
				: 0,
		};
	};

	normalizeOrderTypeForSide = (side, orderType) => {
		const normalizedSide = side === "SELL" ? "SELL" : "BUY";
		const requestedType = String(orderType || "LIMIT").toUpperCase();
		const normalizedType = requestedType === "TRAILING"
			? "TRAILING_MARKET"
			: requestedType;
		const allowedTypes = normalizedSide === "SELL"
			? ["LIMIT", "MARKET", "STOP_LIMIT", "BRACKET", "TRAILING_MARKET", "TRAILING_LIMIT"]
			: ["LIMIT", "MARKET", "STOP_LIMIT"];

		return allowedTypes.includes(normalizedType) ? normalizedType : "LIMIT";
	};

	isTrailingOrderType = (orderType) => (
		orderType === "TRAILING_MARKET" || orderType === "TRAILING_LIMIT"
	);

	getSellStopOrderType = (orderType, fallback = "BRACKET") => {
		const normalized = this.normalizeOrderTypeForSide("SELL", orderType);

		return (
			normalized === "STOP_LIMIT"
			|| normalized === "BRACKET"
			|| this.isTrailingOrderType(normalized)
		)
			? normalized
			: fallback;
	};

	getTicketPrimaryOrderType = (ticket) => {
		const orderType = this.normalizeOrderTypeForSide(ticket?.side, ticket?.orderType);

		return orderType === "STOP_LIMIT" || orderType === "BRACKET" || this.isTrailingOrderType(orderType)
			? "STOP"
			: orderType;
	};

	getDefaultAmountModeForSide = (side) => (
		side === "SELL" ? "BASE" : "USD"
	);

	getSavedTrailingPercent = () => {
		const value = Number(getCookie(TRAILING_PERCENT_COOKIE));

		return Number.isFinite(value) && value > 0 && value < 100
			? String(value)
			: TRAILING_DEFAULT_PERCENT;
	};

	getSavedAmountModeForSide = (side, saved = {}) => (
		saved.amountMode === "USD" || saved.amountMode === "BASE"
			? saved.amountMode
			: this.getDefaultAmountModeForSide(side)
	);

	getDefaultOrderSideForPrice = (price) => {
		const numericPrice = Number(price);
		const currentPrice = Number(this.state.candles[this.state.candles.length - 1]?.close);

		if (!Number.isFinite(numericPrice) || !Number.isFinite(currentPrice)) {
			return this.state.lastOrderSide === "SELL" ? "SELL" : "BUY";
		}

		return numericPrice > currentPrice ? "SELL" : "BUY";
	};

	getOrderTicketDefaults = (price, side = this.state.lastOrderSide) => {
		const normalizedSide = side === "SELL" ? "SELL" : "BUY";
		const numericPrice = Number(price);
		const saved = this.state.savedOrderTickets[normalizedSide] || {};
		const priceValue = Number.isFinite(numericPrice) ? this.getOrderPriceInputValue(numericPrice) : "0";
		const takeProfitValue = Number.isFinite(numericPrice)
			? this.getOrderPriceInputValue(numericPrice * BRACKET_DEFAULT_TAKE_PROFIT_FACTOR)
			: "0";
		const stopLossValue = Number.isFinite(numericPrice)
			? this.getOrderPriceInputValue(numericPrice * BRACKET_DEFAULT_STOP_LOSS_FACTOR)
			: "0";

		return {
			...saved,
			side: normalizedSide,
			orderType: "LIMIT",
			lastSellStopOrderType: this.getSellStopOrderType(
				saved.lastSellStopOrderType || saved.orderType,
			),
			amountMode: this.getSavedAmountModeForSide(normalizedSide, saved),
			activePriceField: "price",
			anchorPrice: Number.isFinite(numericPrice) ? numericPrice : null,
			anchorOffsetY: ORDER_TICKET_ANCHOR_OFFSET_Y,
			anchorY: this.state.orderScaleHover?.y ?? this.state.chartSize.height / 2,
			price: priceValue,
			stopPrice: Number.isFinite(Number(saved.stopPrice)) ? this.getOrderPriceInputValue(saved.stopPrice) : priceValue,
			takeProfitPrice: Number.isFinite(Number(saved.takeProfitPrice)) ? this.getOrderPriceInputValue(saved.takeProfitPrice) : takeProfitValue,
			stopLossPrice: Number.isFinite(Number(saved.stopLossPrice)) ? this.getOrderPriceInputValue(saved.stopLossPrice) : stopLossValue,
			trailPercent: Number.isFinite(Number(saved.trailPercent))
				? String(saved.trailPercent)
				: this.getSavedTrailingPercent(),
			amount: "0",
			fraction: 0,
			error: "",
			isSubmitting: false,
			preview: null,
			previewBodyKey: "",
			previewError: "",
			previewMarketPrice: null,
			isPreviewLoading: false,
			previewRequestedAt: null,
		};
	};

	getSavedOrderSnapshot = (ticket) => (
		ticket
			? {
				side: ticket.side,
				orderType: ticket.orderType,
				lastSellStopOrderType: ticket.lastSellStopOrderType,
				amountMode: ticket.amountMode,
				price: ticket.price,
				stopPrice: ticket.stopPrice,
				takeProfitPrice: ticket.takeProfitPrice,
				stopLossPrice: ticket.stopLossPrice,
				trailPercent: ticket.trailPercent,
				amount: ticket.amount,
				fraction: ticket.fraction,
			}
			: null
	);

	clearSavedOrderTicketAmounts = (savedOrderTickets = {}) => ({
		BUY: savedOrderTickets.BUY
			? {
				...savedOrderTickets.BUY,
				amount: "0",
				fraction: 0,
			}
			: null,
		SELL: savedOrderTickets.SELL
			? {
				...savedOrderTickets.SELL,
				amount: "0",
				fraction: 0,
			}
			: null,
	});

	mergeOrderTicketForSide = (
		side,
		price,
		savedOrderTickets = this.state.savedOrderTickets,
		currentTicket = this.state.orderTicket
	) => {
		const normalizedSide = side === "SELL" ? "SELL" : "BUY";
		const numericPrice = Number(price);
		const saved = savedOrderTickets[normalizedSide] || {};
		const priceValue = Number.isFinite(numericPrice)
			? this.getOrderPriceInputValue(numericPrice)
			: Number.isFinite(Number(currentTicket?.price))
				? this.getOrderPriceInputValue(currentTicket.price)
				: "0";
		const takeProfitValue = Number.isFinite(numericPrice)
			? this.getOrderPriceInputValue(numericPrice * BRACKET_DEFAULT_TAKE_PROFIT_FACTOR)
			: "0";
		const stopLossValue = Number.isFinite(numericPrice)
			? this.getOrderPriceInputValue(numericPrice * BRACKET_DEFAULT_STOP_LOSS_FACTOR)
			: "0";
		const nextOrderType = this.normalizeOrderTypeForSide(normalizedSide, saved.orderType);
		const amount = saved.amount ?? "0";
		const ticket = {
			...saved,
			side: normalizedSide,
			orderType: nextOrderType,
			lastSellStopOrderType: this.getSellStopOrderType(
				saved.lastSellStopOrderType || saved.orderType,
			),
			amountMode: this.getSavedAmountModeForSide(normalizedSide, saved),
			activePriceField: "price",
			anchorPrice: Number.isFinite(Number(currentTicket?.anchorPrice))
				? Number(currentTicket.anchorPrice)
				: Number.isFinite(numericPrice)
					? numericPrice
					: null,
			anchorOffsetY: Number.isFinite(Number(currentTicket?.anchorOffsetY))
				? Number(currentTicket.anchorOffsetY)
				: ORDER_TICKET_ANCHOR_OFFSET_Y,
			anchorY: this.state.orderScaleHover?.y ?? currentTicket?.anchorY ?? this.state.chartSize.height / 2,
			price: priceValue,
			stopPrice: priceValue,
			takeProfitPrice: Number.isFinite(Number(saved.takeProfitPrice)) ? this.getOrderPriceInputValue(saved.takeProfitPrice) : takeProfitValue,
			stopLossPrice: Number.isFinite(Number(saved.stopLossPrice)) ? this.getOrderPriceInputValue(saved.stopLossPrice) : stopLossValue,
			trailPercent: Number.isFinite(Number(saved.trailPercent))
				? String(saved.trailPercent)
				: this.getSavedTrailingPercent(),
			amount,
			error: "",
			isSubmitting: false,
			preview: null,
			previewBodyKey: "",
			previewError: "",
			previewMarketPrice: null,
			isPreviewLoading: false,
			previewRequestedAt: null,
		};

		return this.clampOrderTicketAmount({
			...ticket,
			fraction: this.getOrderFractionFromAmount(ticket),
		});
	};

	switchOrderSide = (side) => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		const normalizedSide = side === "SELL" ? "SELL" : "BUY";
		if (ticket.side === normalizedSide) return;

		const price = Number(ticket.price);

		this.setState(prev => {
			const savedOrderTickets = {
				...prev.savedOrderTickets,
				[ticket.side]: this.getSavedOrderSnapshot(ticket),
			};

			return {
				savedOrderTickets,
				lastOrderSide: normalizedSide,
				orderTicket: this.mergeOrderTicketForSide(normalizedSide, price, savedOrderTickets, ticket),
			};
		}, () => {
			this.scheduleOrderPreview();
		});
	};

	applyOrderHoverPrice = (event) => {
		event.preventDefault();
		event.stopPropagation();

		const hover = this.state.orderScaleHover;
		if (!hover) return;

		if (!this.state.orderTicket) {
			if (this.state.isOrderTicketClosing || this.orderTicketCloseTimer) {
				return;
			}

			const side = this.getDefaultOrderSideForPrice(hover.price);

			this.setState(prev => ({
				savedOrderTickets: this.clearSavedOrderTicketAmounts(prev.savedOrderTickets),
				orderTicket: this.getOrderTicketDefaults(hover.price, side),
				isOrderTicketClosing: false,
				lastOrderSide: side,
			}), () => {
				this.refreshBalancesManually("order_overlay_open");
				this.scheduleOrderPreview();
			});
			return;
		}

		const ticket = this.state.orderTicket;
		if (this.isSellTrailingOrderTicket(ticket)) return;

		const field = ticket.activePriceField || "price";
		const allowedFields = ["price", "stopPrice", "takeProfitPrice", "stopLossPrice"];
		const targetField = allowedFields.includes(field) ? field : "price";
		const priceValue = this.getOrderPriceInputValue(hover.price);

		if (this.isMarketOrderTicket(ticket)) {
			this.cancelOrderPreviewRequests();

			const nextTicket = {
				...ticket,
				orderType: "LIMIT",
				price: priceValue,
				activePriceField: "price",
			};

			this.updateOrderTicket({
				...this.getOrderPreviewResetPatch(),
				orderType: "LIMIT",
				price: priceValue,
				activePriceField: "price",
				fraction: this.getOrderFractionFromAmount(nextTicket),
			}, {
				onCommitted: () => {
					this.stopMarketPreviewPoller();
				},
			});
			return;
		}

		this.updateOrderPriceField(targetField, priceValue, {
			clampBracket: targetField === "takeProfitPrice" || targetField === "stopLossPrice",
		});
	};

	bookmarkOrderHoverPrice = (event) => {
		event.preventDefault();
		event.stopPropagation();

		const hover = this.state.orderScaleHover;
		if (!hover || !Number.isFinite(Number(hover.price))) return;

		const currency = this.state.baseCurrency;
		const price = Number(hover.price);

		setBookmarkedPrice(currency, price);
		this.setState(prev => ({
			appBookmarks: prev.appBookmarks
				? {
					...prev.appBookmarks,
					[String(currency || "").toUpperCase()]: price,
				}
				: prev.appBookmarks,
			bookmarkedPrice: price,
		}), this.scheduleOverlayUpdate);

		api.setBookmark(currency, price).catch(() => {
			this.loadAppState();
		});
	};

	clearBookmarkedPrice = (event) => {
		this.clearBookmarkedPriceForCurrency(this.state.baseCurrency, event);
	};

	clearBookmarkedPriceForCurrency = (currency, event) => {
		if (event) {
			event.preventDefault();
			event.stopPropagation();
		}

		const normalizedCurrency = String(currency || "").trim().toUpperCase();

		if (!normalizedCurrency) return;

		deleteBookmarkedPrice(normalizedCurrency);
		this.setState((prev) => {
			const appBookmarks = prev.appBookmarks
				? { ...prev.appBookmarks }
				: prev.appBookmarks;

			if (appBookmarks) {
				delete appBookmarks[normalizedCurrency];
			}

			const isActiveCurrency = normalizedCurrency === String(prev.baseCurrency || "").trim().toUpperCase();

			return {
				appBookmarks,
				...(isActiveCurrency ? { bookmarkedPrice: null } : {}),
			};
		}, this.scheduleOverlayUpdate);

		api.deleteBookmark(normalizedCurrency)
			.catch(() => {
				this.loadAppState();
			});
	};

	prepareOrderTicketClose = () => {
		this.cancelOrderPreviewRequests();
		this.stopOrderPreviewWaitTicker();

		if (this.orderPreviewTimer) {
			window.clearTimeout(this.orderPreviewTimer);
			this.orderPreviewTimer = null;
		}

		this.stopMarketPreviewPoller();
	};

	scheduleOrderTicketCloseEnd = () => {
		if (this.orderTicketCloseTimer) {
			window.clearTimeout(this.orderTicketCloseTimer);
		}

		this.orderTicketCloseTimer = window.setTimeout(() => {
			this.orderTicketCloseTimer = null;
			this.isOrderTicketPriceDragging = false;
			this.orderTicketPriceDragField = null;
			this.orderTicketPriceDragStartPrice = null;
			this.orderTicketPriceDragGrabOffsetY = 0;
			this.isOrderTicketMoveDragging = false;
			this.orderTicketMoveDrag = null;
			this.setState({
				orderTicket: null,
				isOrderTicketClosing: false,
				isOrderTicketPriceDragging: false,
				isOrderTicketMoveDragging: false,
			});
		}, DROPDOWN_TRANSITION_MS);
	};

	closeOrderTicket = () => {
		const ticket = this.state.orderTicket;
		if (!ticket || this.state.isOrderTicketClosing) return;

		this.prepareOrderTicketClose();

		this.setState({
			isOrderTicketClosing: true,
			lastOrderSide: ticket?.side === "SELL" ? "SELL" : "BUY",
			savedOrderTickets: {
				...this.state.savedOrderTickets,
				[ticket.side]: this.getSavedOrderSnapshot(ticket),
			},
			orderScaleHover: null,
		}, this.scheduleOrderTicketCloseEnd);
	};

	updateOrderTicket = (patch, options = {}) => {
		if (this.state.isOrderTicketClosing) {
			if (typeof options.onCommitted === "function") {
				options.onCommitted();
			}

			return;
		}

		const schedulePreview = options.schedulePreview !== false;

		this.setState(prev => ({
			orderTicket: prev.orderTicket
				? {
					...prev.orderTicket,
					...patch,
					error: Object.prototype.hasOwnProperty.call(patch, "error") ? patch.error : "",
				}
				: prev.orderTicket,
			savedOrderTickets: prev.orderTicket
				? {
					...prev.savedOrderTickets,
					[prev.orderTicket.side]: this.getSavedOrderSnapshot({
						...prev.orderTicket,
						...patch,
						error: Object.prototype.hasOwnProperty.call(patch, "error") ? patch.error : "",
					}),
				}
				: prev.savedOrderTickets,
		}), () => {
			if (schedulePreview && this.state.orderTicket) {
				this.scheduleOrderPreview();
			}

			if (typeof options.onCommitted === "function") {
				options.onCommitted();
			}
		});
	};

	setOrderType = (orderType, options = {}) => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		const normalizedOrderType = this.normalizeOrderTypeForSide(ticket.side, orderType);
		const currentOrderType = this.normalizeOrderTypeForSide(ticket.side, ticket.orderType);

		if (normalizedOrderType === currentOrderType) {
			if (options.closeMenu) {
				this.setState({ isOrderTypeMenuOpen: false });
			} else if (options.openMenu) {
				this.setState({ isOrderTypeMenuOpen: true });
			}
			return;
		}

		this.cancelOrderPreviewRequests();

		const patch = {
			...this.getOrderPreviewResetPatch(),
			orderType: normalizedOrderType,
			...(
				ticket.side === "SELL"
				&& this.getTicketPrimaryOrderType({
					...ticket,
					orderType: normalizedOrderType,
				}) === "STOP"
					? { lastSellStopOrderType: normalizedOrderType }
					: {}
			),
		};

		if (normalizedOrderType === "BRACKET" && ticket.side === "SELL") {
			if (currentOrderType === "LIMIT") {
				const limitPrice = Number(ticket.price);
				const currentPrice = Number(this.getOverlayMarketPrice());

				if (Number.isFinite(limitPrice) && limitPrice > 0) {
					patch.takeProfitPrice = this.getOrderPriceInputValue(limitPrice);

					if (Number.isFinite(currentPrice) && currentPrice > 0) {
						patch.stopLossPrice = this.getOrderPriceInputValue(
							currentPrice - (limitPrice - currentPrice) / 5,
						);
					} else {
						Object.assign(patch, this.getBracketDefaultPrices(limitPrice));
						patch.takeProfitPrice = this.getOrderPriceInputValue(limitPrice);
					}
				} else {
					Object.assign(patch, this.getBracketDefaultPrices(this.getBracketReferencePrice(ticket)));
				}
			} else {
				Object.assign(patch, this.getBracketDefaultPrices(this.getBracketReferencePrice(ticket)));
			}

			patch.activePriceField = "takeProfitPrice";
		} else if (this.isTrailingOrderType(normalizedOrderType) && ticket.side === "SELL") {
			patch.activePriceField = "trailPercent";
		} else if (normalizedOrderType === "LIMIT") {
			patch.activePriceField = "price";
		}

		this.updateOrderTicket(patch, {
			onCommitted: () => {
				if (options.closeMenu) {
					this.setState({ isOrderTypeMenuOpen: false });
				} else if (options.openMenu) {
					this.setState({ isOrderTypeMenuOpen: true });
				}
				this.syncMarketPreviewPoller();
			},
		});
	};

	setSellStopOrderType = (orderType) => {
		this.setOrderType(orderType, { closeMenu: true });
	};

	getOrderFractionFromAmount = (ticket, amountValue = ticket?.amount, maxAmount = null) => {
		if (!ticket) return 0;

		const amount = Number(amountValue);
		const resolvedMaxAmount = Number.isFinite(maxAmount)
			? maxAmount
			: this.getOrderMaxAmount(ticket);

		if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(resolvedMaxAmount) || resolvedMaxAmount <= 0) {
			return 0;
		}

		return Math.max(0, Math.min(1, amount / resolvedMaxAmount));
	};

	syncOrderTicketOnBalanceChange = (prevState) => {
		const ticket = this.state.orderTicket;

		if (!ticket) return;

		const prevMax = this.getOrderMaxAmount(ticket, prevState.profile);
		const nextMax = this.getOrderMaxAmount(ticket);

		if (prevMax === nextMax) return;

		const clampedTicket = this.clampOrderTicketAmount(ticket);
		const nextAmount = clampedTicket.amount;
		const nextFraction = clampedTicket.fraction;
		const amountChanged = String(nextAmount) !== String(ticket.amount);
		const fractionChanged = nextFraction !== ticket.fraction;

		if (!amountChanged && !fractionChanged) return;

		const patch = {
			fraction: nextFraction,
			amount: nextAmount,
		};

		if (amountChanged) {
			Object.assign(patch, this.getOrderPreviewResetPatch());
		}

		this.updateOrderTicket(patch, {
			schedulePreview: amountChanged && Number(nextAmount) > 0,
		});
	};

	isOrderTicketZeroAvailable = (ticket = this.state.orderTicket, profile = this.state.profile) => (
		!ticket || this.getOrderMaxAmount(ticket, profile) <= 0
	);

	isSellZeroBalanceTicket = (ticket = this.state.orderTicket) => (
		ticket?.side === "SELL" && this.isOrderTicketZeroAvailable(ticket)
	);

	getOrderReferencePrice = (ticket) => {
		if (!ticket) return NaN;

		const orderType = this.normalizeOrderTypeForSide(ticket.side, ticket.orderType);
		const price = Number(ticket.price);
		const takeProfitPrice = Number(ticket.takeProfitPrice);
		const overlayPrice = this.getOverlayMarketPrice();

		if (orderType === "BRACKET" && Number.isFinite(takeProfitPrice) && takeProfitPrice > 0) {
			return takeProfitPrice;
		}

		if (orderType !== "MARKET" && !this.isTrailingOrderType(orderType) && Number.isFinite(price) && price > 0) {
			return price;
		}

		return Number.isFinite(overlayPrice) && overlayPrice > 0 ? overlayPrice : price;
	};

	getOrderMaxAmount = (ticket, profile = this.state.profile) => {
		if (!ticket) return 0;

		const available = this.getAvailableBalanceForSide(ticket.side, profile);
		const referencePrice = this.getOrderReferencePrice(ticket);
		const availableAmount = Number(available.amount) || 0;

		if (ticket.side === "BUY") {
			if (ticket.amountMode === "USD") {
				return floorQuoteCurrencyAmount(
					Math.max(0, availableAmount - BUY_USD_MAX_HEADROOM),
				);
			}

			return referencePrice > 0
				? availableAmount / referencePrice
				: 0;
		}

		return ticket.amountMode === "USD"
			? referencePrice > 0
				? availableAmount * referencePrice
				: 0
			: availableAmount;
	};

	updateOrderAmount = (amount) => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;
		const sanitizedAmount = sanitizeNumericInput(amount);

		this.cancelOrderPreviewRequests();

		this.updateOrderTicket({
			...this.getOrderPreviewResetPatch(),
			amount: sanitizedAmount,
			fraction: this.getOrderFractionFromAmount(ticket, sanitizedAmount),
		});
	};

	stepOrderAmount = (direction) => {
		const ticket = this.state.orderTicket;
		if (!ticket || this.isOrderTicketZeroAvailable(ticket)) return;

		const sign = direction > 0 ? 1 : direction < 0 ? -1 : 0;
		if (!sign) return;

		const currentAmount = Number(ticket.amount);
		const safeAmount = Number.isFinite(currentAmount) ? currentAmount : 0;
		let step = 1;

		if (ticket.amountMode !== "USD") {
			const referencePrice = this.getOrderReferencePrice(ticket);

			if (!Number.isFinite(referencePrice) || referencePrice <= 0) return;

			step = 1 / referencePrice;
		}

		const maxAmount = this.getOrderMaxAmount(ticket);
		const safeMaxAmount = Number.isFinite(maxAmount) && maxAmount > 0 ? maxAmount : 0;
		const nextAmount = this.getOrderAmountInputValue(
			ticket,
			Math.max(0, Math.min(safeAmount + sign * step, safeMaxAmount)),
		);

		this.cancelOrderPreviewRequests();

		this.updateOrderTicket({
			...this.getOrderPreviewResetPatch(),
			amount: nextAmount,
			fraction: this.getOrderFractionFromAmount(ticket, nextAmount),
		});
	};

	handleOrderAmountKeyDown = (event) => {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

		event.preventDefault();
		this.stepOrderAmount(event.key === "ArrowUp" ? 1 : -1);
	};

	formatOrderAmountInput = () => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		const amount = Number(ticket.amount);
		if (!Number.isFinite(amount)) return;

		const clampedTicket = this.clampOrderTicketAmount({
			...ticket,
			amount: this.getOrderAmountInputValue(ticket, amount),
		});
		const formattedAmount = clampedTicket.amount;
		const nextFraction = clampedTicket.fraction;
		const amountUnchanged = String(formattedAmount) === String(ticket.amount);
		const fractionUnchanged = nextFraction === ticket.fraction;

		this.updateOrderTicket({
			amount: formattedAmount,
			fraction: nextFraction,
		}, {
			schedulePreview: !(amountUnchanged && fractionUnchanged),
		});
	};

	updateOrderPriceField = (field, value, options = {}) => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		const sanitizedValue = sanitizeNumericInput(value);
		let patch = {
			[field]: sanitizedValue,
			activePriceField: field,
		};

		if (
			options.clampBracket
			&& this.isSellBracketOrderTicket(ticket)
			&& (field === "takeProfitPrice" || field === "stopLossPrice")
		) {
			patch = this.clampBracketPricePatch(ticket, patch);
		}

		const nextTicket = {
			...ticket,
			...patch,
		};

		this.updateOrderTicket({
			...patch,
			fraction: this.getOrderFractionFromAmount(nextTicket),
		}, {
			schedulePreview: options.schedulePreview !== false,
		});
	};

	isLimitOrderTicket = (ticket = this.state.orderTicket) => {
		if (!ticket) return false;

		return this.normalizeOrderTypeForSide(ticket.side, ticket.orderType) === "LIMIT";
	};

	isSellBracketOrderTicket = (ticket = this.state.orderTicket) => {
		if (!ticket || ticket.side !== "SELL") return false;

		return this.normalizeOrderTypeForSide(ticket.side, ticket.orderType) === "BRACKET";
	};

	isSellTrailingOrderTicket = (ticket = this.state.orderTicket) => {
		if (!ticket || ticket.side !== "SELL") return false;

		return this.isTrailingOrderType(
			this.normalizeOrderTypeForSide(ticket.side, ticket.orderType)
		);
	};

	getBracketReferencePrice = (ticket = this.state.orderTicket) => {
		const overlayPrice = Number(this.getOverlayMarketPrice());

		if (Number.isFinite(overlayPrice) && overlayPrice > 0) {
			return overlayPrice;
		}

		const ticketPrice = Number(ticket?.price);

		if (Number.isFinite(ticketPrice) && ticketPrice > 0) {
			return ticketPrice;
		}

		const anchorPrice = Number(ticket?.anchorPrice);

		if (Number.isFinite(anchorPrice) && anchorPrice > 0) {
			return anchorPrice;
		}

		return NaN;
	};

	getBracketDefaultPrices = (referencePrice) => {
		const basePrice = Number(referencePrice);

		if (!Number.isFinite(basePrice) || basePrice <= 0) {
			return {
				takeProfitPrice: "0",
				stopLossPrice: "0",
			};
		}

		return {
			takeProfitPrice: this.getOrderPriceInputValue(basePrice * BRACKET_DEFAULT_TAKE_PROFIT_FACTOR),
			stopLossPrice: this.getOrderPriceInputValue(basePrice * BRACKET_DEFAULT_STOP_LOSS_FACTOR),
		};
	};

	clampBracketPricePatch = (ticket, patch = {}) => {
		const nextPatch = { ...patch };
		const takeProfitPrice = Number(
			Object.prototype.hasOwnProperty.call(nextPatch, "takeProfitPrice")
				? nextPatch.takeProfitPrice
				: ticket.takeProfitPrice,
		);
		const stopLossPrice = Number(
			Object.prototype.hasOwnProperty.call(nextPatch, "stopLossPrice")
				? nextPatch.stopLossPrice
				: ticket.stopLossPrice,
		);

		if (
			!Number.isFinite(takeProfitPrice)
			|| !Number.isFinite(stopLossPrice)
			|| takeProfitPrice >= stopLossPrice
		) {
			return nextPatch;
		}

		if (
			Object.prototype.hasOwnProperty.call(nextPatch, "takeProfitPrice")
			&& !Object.prototype.hasOwnProperty.call(nextPatch, "stopLossPrice")
		) {
			nextPatch.takeProfitPrice = this.getOrderPriceInputValue(stopLossPrice);
			return nextPatch;
		}

		if (
			Object.prototype.hasOwnProperty.call(nextPatch, "stopLossPrice")
			&& !Object.prototype.hasOwnProperty.call(nextPatch, "takeProfitPrice")
		) {
			nextPatch.stopLossPrice = this.getOrderPriceInputValue(takeProfitPrice);
			return nextPatch;
		}

		nextPatch.takeProfitPrice = this.getOrderPriceInputValue(Math.max(takeProfitPrice, stopLossPrice));
		nextPatch.stopLossPrice = this.getOrderPriceInputValue(Math.min(takeProfitPrice, stopLossPrice));
		return nextPatch;
	};

	setOrderTicketLimitPrice = (price, options = {}) => {
		const ticket = this.state.orderTicket;

		if (!ticket || !this.isLimitOrderTicket(ticket)) return;

		const numericPrice = Number(price);

		if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;

		const priceValue = this.getOrderPriceInputValue(numericPrice);
		const nextTicket = {
			...ticket,
			price: priceValue,
		};

		this.updateOrderTicket({
			price: priceValue,
			activePriceField: "price",
			fraction: this.getOrderFractionFromAmount(nextTicket),
		}, {
			schedulePreview: options.schedulePreview !== false,
		});
	};

	setOrderTicketDragPrice = (field, price, options = {}) => {
		const ticket = this.state.orderTicket;

		if (!ticket) return;

		const numericPrice = Number(price);

		if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;

		if (field === "price") {
			this.setOrderTicketLimitPrice(numericPrice, options);
			return;
		}

		if (
			(field === "takeProfitPrice" || field === "stopLossPrice")
			&& this.isSellBracketOrderTicket(ticket)
		) {
			this.updateOrderPriceField(
				field,
				this.getOrderPriceInputValue(numericPrice),
				{
					...options,
					clampBracket: true,
				},
			);
		}
	};

	getOrderPriceHandleLabel = (price, { showPercent = false } = {}) => {
		const priceLabel = this.formatOverlayPriceForProduct(price);

		if (!showPercent) return priceLabel;

		const bookmarkedPrice = Number(this.getBookmarkedPriceForCurrency(this.state.baseCurrency));
		const referencePrice = Number.isFinite(bookmarkedPrice) && bookmarkedPrice > 0
			? bookmarkedPrice
			: Number(this.getOverlayMarketPrice());

		if (!Number.isFinite(referencePrice) || referencePrice === 0 || !Number.isFinite(Number(price))) {
			return priceLabel;
		}

		const percent = ((Number(price) - referencePrice) / referencePrice) * 100;

		return `${priceLabel} (${formatSignedPercent(percent)})`;
	};

	getReferenceLineMarketDelta = (linePriceValue) => {
		const linePrice = Number(linePriceValue);

		if (!Number.isFinite(linePrice) || linePrice <= 0) return null;

		const livePrice = Number(this.getOverlayMarketPrice());

		if (!Number.isFinite(livePrice) || livePrice <= 0) return null;

		const deltaPrice = linePrice - livePrice;
		const deltaPercent = (deltaPrice / linePrice) * 100;

		if (!Number.isFinite(deltaPercent)) return null;

		const deltaPriceLabel = deltaPrice >= 0
			? `+${this.formatOverlayPriceForProduct(deltaPrice)}`
			: `-${this.formatOverlayPriceForProduct(Math.abs(deltaPrice))}`;

		return {
			deltaPriceLabel,
			deltaPercent,
		};
	};

	getReferenceLinePriceLabel = (referencePrice, { prefix = "" } = {}) => {
		const priceLabel = this.formatOverlayPriceForProduct(referencePrice);

		return prefix ? `${prefix} ${priceLabel}` : priceLabel;
	};

	getReferenceLineDeltaLabel = (referencePrice) => {
		const delta = this.getReferenceLineMarketDelta(referencePrice);

		if (!delta) return null;

		return `${delta.deltaPriceLabel} (${formatSignedPercent(delta.deltaPercent)})`;
	};

	getPriceFromPointerEvent = (event, grabOffsetY = 0) => {
		const el = this.chartRef.current;
		if (!el || !this.candleSeries) return null;

		const rect = el.getBoundingClientRect();
		const y = event.clientY - rect.top - (Number(grabOffsetY) || 0);
		const price = this.candleSeries.coordinateToPrice(y);

		return Number.isFinite(price) && price > 0 ? price : null;
	};

	getPriceDragGrabOffsetY = (event, price) => {
		const el = this.chartRef.current;
		const handleY = this.priceToY(price);

		if (!el || !Number.isFinite(handleY)) return 0;

		const rect = el.getBoundingClientRect();
		const pointerY = event.clientY - rect.top;

		return pointerY - handleY;
	};

	handleOrderTicketPriceDragStart = (event, field = "price") => {
		if (event.button != null && event.button !== 0) return;
		if (this.isOpenOrderPriceDragging) return;

		const ticket = this.state.orderTicket;
		if (!ticket) return;

		if (field === "price") {
			if (!this.isLimitOrderTicket(ticket)) return;
		} else if (field === "takeProfitPrice" || field === "stopLossPrice") {
			if (!this.isSellBracketOrderTicket(ticket)) return;
		} else {
			return;
		}

		event.preventDefault();
		event.stopPropagation();

		const startPrice = Number(ticket[field]);
		this.orderTicketPriceDragField = field;
		this.orderTicketPriceDragStartPrice = (
			Number.isFinite(startPrice) && startPrice > 0
				? startPrice
				: null
		);
		this.orderTicketPriceDragGrabOffsetY = (
			Number.isFinite(startPrice) && startPrice > 0
				? this.getPriceDragGrabOffsetY(event, startPrice)
				: 0
		);
		this.isOrderTicketPriceDragging = true;
		this.setState({ isOrderTicketPriceDragging: true });
		this.updateOrderTicket({ activePriceField: field }, { schedulePreview: false });
	};

	handleOrderTicketPriceDragMove = (event) => {
		if (this.isOpenOrderPriceDragging) {
			this.handleOpenOrderPriceDragMove(event);
			return;
		}

		if (!this.isOrderTicketPriceDragging || !this.candleSeries) return;

		const price = this.getPriceFromPointerEvent(
			event,
			this.orderTicketPriceDragGrabOffsetY,
		);

		if (!Number.isFinite(price) || price <= 0) return;

		this.setOrderTicketDragPrice(
			this.orderTicketPriceDragField || "price",
			price,
			{ schedulePreview: false },
		);
	};

	cancelOrderTicketPriceDrag = () => {
		if (!this.isOrderTicketPriceDragging) return;

		const field = this.orderTicketPriceDragField || "price";
		const startPrice = Number(this.orderTicketPriceDragStartPrice);

		this.isOrderTicketPriceDragging = false;
		this.orderTicketPriceDragField = null;
		this.orderTicketPriceDragStartPrice = null;
		this.orderTicketPriceDragGrabOffsetY = 0;

		this.setState({ isOrderTicketPriceDragging: false }, () => {
			if (Number.isFinite(startPrice) && startPrice > 0) {
				this.setOrderTicketDragPrice(field, startPrice, { schedulePreview: true });
				return;
			}

			if (this.state.orderTicket) {
				this.scheduleOrderPreview();
			}
		});
	};

	handleOrderTicketPriceDragEnd = () => {
		if (this.isOpenOrderPriceDragging) {
			this.handleOpenOrderPriceDragEnd();
			return;
		}

		if (!this.isOrderTicketPriceDragging) return;

		this.isOrderTicketPriceDragging = false;
		this.orderTicketPriceDragField = null;
		this.orderTicketPriceDragStartPrice = null;
		this.orderTicketPriceDragGrabOffsetY = 0;
		this.setState({ isOrderTicketPriceDragging: false }, () => {
			if (this.state.orderTicket) {
				this.scheduleOrderPreview();
			}
		});
	};

	releaseOpenOrderPointerCapture = () => {
		const el = this.openOrderDragCaptureEl;
		const pointerId = this.openOrderDragPointerId;

		if (el && pointerId != null && el.hasPointerCapture?.(pointerId)) {
			try {
				el.releasePointerCapture(pointerId);
			} catch {
				// Element may already be gone after remount.
			}
		}

		this.openOrderDragCaptureEl = null;
		this.openOrderDragPointerId = null;
	};

	cancelOpenOrderPriceDrag = () => {
		if (!this.isOpenOrderPriceDragging && !this.state.openOrderDrag) return;
		if (this.state.openOrderDrag?.pending) return;

		this.isOpenOrderPriceDragging = false;
		this.openOrderPriceDragGrabOffsetY = 0;
		this.openOrderDragFrozenTotals = null;
		this.openOrderDragFrozenLimitTotal = null;
		this.releaseOpenOrderPointerCapture();
		this.setOrderLineDisplayPlace("cancelOpenOrderPriceDrag");
		this.noteDragOwnerIfChanged("cancelOpenOrderPriceDrag", null);
		this.setState({ openOrderDrag: null }, this.schedulePriceOverlayUpdate);
	};

	getOpenOrderEditHandleKey = (orderId, kind = "limit") => (
		kind === "limit" ? `open:${orderId}` : `open:${orderId}:${kind}`
	);

	getOpenOrderEditSize = (order) => {
		const candidates = [
			order?.amount,
			order?.leaves_quantity,
			order?.base_size,
			order?.total_base_size,
		];

		for (const candidate of candidates) {
			const size = Number(candidate);
			if (Number.isFinite(size) && size > 0) return size;
		}

		const legs = Array.isArray(order?.bracket_legs) ? order.bracket_legs : [];
		for (const leg of legs) {
			for (const candidate of [leg?.amount, leg?.base_size, leg?.total_base_size]) {
				const size = Number(candidate);
				if (Number.isFinite(size) && size > 0) return size;
			}
		}

		return null;
	};

	findOpenOrderById = (orderId) => {
		const list = Array.isArray(this.state.allOrders) ? this.state.allOrders : [];
		const index = findOrderEditIndex(list, orderId);
		return index >= 0 ? list[index] : null;
	};

	patchAllOrdersRow = (orders, orderId, updater) => {
		const list = Array.isArray(orders) ? orders : [];
		const index = findOrderEditIndex(list, orderId);
		if (index < 0) {
			const created = updater(null);
			return created ? [...list, created] : list;
		}

		const patched = updater(list[index]);
		if (!patched) return list.filter((_, itemIndex) => itemIndex !== index);

		return list.map((order, itemIndex) => (
			itemIndex === index ? patched : order
		));
	};

	isOpenOrderMoveLocked = (order) => {
		const status = String(order?.status || "").toUpperCase();
		return status === "PENDING" || Boolean(order?.pending_request_id);
	};

	readPollsAfterMove = (order) => {
		const count = Number(order?.pollsAfterMove);
		return Number.isFinite(count) && count >= 0 ? count : POLLS_AFTER_MOVE_MAX;
	};

	applyPointerPriceToOrder = (order, drag, price) => {
		if (!order) return null;

		const next = { ...order };
		const kind = String(drag?.kind || "limit").toLowerCase();

		if (kind === "stop_loss" && Array.isArray(next.bracket_legs)) {
			next.bracket_legs = next.bracket_legs.map(leg => (
				String(leg?.role || "").toLowerCase() === "stop_loss"
					? { ...leg, price }
					: leg
			));
		} else if (kind === "take_profit" && Array.isArray(next.bracket_legs)) {
			next.price = price;
			next.bracket_legs = next.bracket_legs.map(leg => (
				String(leg?.role || "").toLowerCase() === "take_profit"
					? { ...leg, price }
					: leg
			));
		} else if (Number.isFinite(price) && price > 0) {
			next.price = price;
		}

		return enrichOrderForDisplay(next);
	};

	stampOpenOrderEditPending = (order, drag, price, pendingRequestId) => {
		const next = this.applyPointerPriceToOrder(order, drag, price);
		if (!next) return null;
		return enrichOrderForDisplay({
			...next,
			status: "PENDING",
			pending_request_id: pendingRequestId,
		});
	};

	orderDisplayPricesDiffer = (local, incoming) => {
		if (!local || !incoming) return false;
		if (Number(local.price) !== Number(incoming.price)) return true;

		const localLegs = Array.isArray(local.bracket_legs) ? local.bracket_legs : [];
		const incomingLegs = Array.isArray(incoming.bracket_legs) ? incoming.bracket_legs : [];
		for (const role of ["take_profit", "stop_loss"]) {
			const localLeg = localLegs.find(leg => String(leg?.role || "").toLowerCase() === role);
			const incomingLeg = incomingLegs.find(leg => String(leg?.role || "").toLowerCase() === role);
			const localPrice = localLeg?.price;
			const incomingPrice = incomingLeg?.price;
			if (
				(Number.isFinite(Number(localPrice)) || Number.isFinite(Number(incomingPrice)))
				&& Number(localPrice) !== Number(incomingPrice)
			) {
				return true;
			}
		}

		return false;
	};

	keepLocalDisplayPrices = (incoming, local) => {
		if (!incoming || !local) return incoming;

		const next = {
			...incoming,
			price: local.price,
		};
		if (local.stop_price !== undefined) {
			next.stop_price = local.stop_price;
		}

		const localLegs = Array.isArray(local.bracket_legs) ? local.bracket_legs : [];
		const incomingLegs = Array.isArray(incoming.bracket_legs) ? incoming.bracket_legs : [];
		if (localLegs.length && incomingLegs.length) {
			next.bracket_legs = incomingLegs.map(leg => {
				const role = String(leg?.role || "").toLowerCase();
				const localLeg = localLegs.find(item => String(item?.role || "").toLowerCase() === role);
				if (localLeg && Number.isFinite(Number(localLeg.price))) {
					return { ...leg, price: localLeg.price };
				}
				return leg;
			});
		} else if (localLegs.length) {
			next.bracket_legs = localLegs;
		}

		return enrichOrderForDisplay(next);
	};

	// One merge rule for the REST orders poll and the socket orders_update: both
	// deliver the same backend all_orders list.
	// NOW = row in allOrders, NEW = incoming row with the same original_id.
	mergeIncomingOrderRow = (now, incoming) => {
		// This tab is awaiting its EDIT response: only that response may touch the row.
		if (now?.pending_request_id) {
			return { order: now, case: "hold_pending_request_id" };
		}
		if (!incoming) {
			return { order: null, case: "drop_missing" };
		}
		if (!now) {
			return { order: incoming, case: "add_new" };
		}

		const incomingStatus = String(incoming.status || "").toUpperCase();
		if (incomingStatus === "PENDING") {
			return { order: now, case: "ignore_incoming_pending" };
		}
		if (incomingStatus === "ERROR") {
			return { order: { ...incoming, pollsAfterMove: 0 }, case: "apply_error" };
		}

		if (!this.orderDisplayPricesDiffer(now, incoming)) {
			return {
				order: { ...incoming, pollsAfterMove: POLLS_AFTER_MOVE_MAX },
				case: "prices_match_accept",
			};
		}

		const count = this.readPollsAfterMove(now);
		if (count < POLLS_AFTER_MOVE_MAX) {
			return {
				order: {
					...this.keepLocalDisplayPrices(incoming, now),
					pollsAfterMove: count + 1,
				},
				case: "hold_local_prices_poll",
			};
		}

		return {
			order: { ...incoming, pollsAfterMove: POLLS_AFTER_MOVE_MAX },
			case: "accept_incoming_prices",
		};
	};

	adoptIncomingOrders = (prevAllOrders, incomingOrders, source) => {
		this.setOrderLineDisplayPlace(source);

		const prevList = Array.isArray(prevAllOrders) ? prevAllOrders : [];
		const incomingList = uniqueOrdersByOriginalId(
			(Array.isArray(incomingOrders) ? incomingOrders : []).map(enrichOrderForDisplay),
		).filter(order => (
			isDisplayableOrderStatus(order.status)
			&& String(order?.order_type || "").toUpperCase() !== "MARKET"
		));

		const prevById = new Map();
		prevList.forEach(order => {
			const id = String(order?.original_id || "").trim();
			if (id) prevById.set(id, order);
		});

		const seen = new Set();
		const allOrders = [];
		const notices = [];
		const mergeCases = [];

		incomingList.forEach(incoming => {
			const id = String(incoming?.original_id || "").trim();
			if (!id) return;
			seen.add(id);
			const now = prevById.get(id) || null;
			const merged = this.mergeIncomingOrderRow(now, incoming);
			const next = merged.order;
			if (next) allOrders.push(next);

			let rowCase = merged.case;
			// This tab's BUY replace: the EDIT response was PENDING (pollsAfterMove = 0);
			// the final status arrives here, so the notice is shown here.
			const awaitingBuyReplace = (
				String(now?.status || "").toUpperCase() === "PENDING"
				&& !now?.pending_request_id
				&& Number(now?.pollsAfterMove) === 0
			);
			if (awaitingBuyReplace) {
				const incomingStatus = String(incoming?.status || "").toUpperCase();
				if (incomingStatus === "OPEN") {
					rowCase = "buy_replace_resolve_open";
					notices.push({ tone: "success", message: "Order successfully updated" });
				} else if (incomingStatus === "ERROR") {
					rowCase = "buy_replace_resolve_error";
					notices.push({ tone: "error", message: "Unable to update order." });
				}
			}

			mergeCases.push({
				original_id: id,
				case: rowCase,
				from_status: now ? String(now.status || "").toUpperCase() : null,
				to_status: String(incoming?.status || "").toUpperCase(),
				from_price: now ? Number(now.price) : null,
				to_price: Number(incoming?.price),
				pollsAfterMove: next ? this.readPollsAfterMove(next) : null,
			});
		});

		prevList.forEach(now => {
			const id = String(now?.original_id || "").trim();
			if (!id || seen.has(id)) return;
			const merged = this.mergeIncomingOrderRow(now, null);
			const next = merged.order;
			if (next) allOrders.push(next);
			mergeCases.push({
				original_id: id,
				case: merged.case,
				from_status: String(now.status || "").toUpperCase(),
				to_status: null,
				from_price: Number(now.price),
				to_price: null,
				pollsAfterMove: next ? this.readPollsAfterMove(next) : null,
			});
		});

		this.diffChartOrderLines(prevList, allOrders, source);

		return { allOrders, notices, mergeCases };
	};

	showMergeNotices = (notices) => {
		(Array.isArray(notices) ? notices : []).forEach(notice => {
			this.showChartNotice(notice.message, { tone: notice.tone });
		});
	};

	orderIsActiveDragTarget = (order, drag) => {
		if (!drag || !order) return false;

		const dragId = String(drag.orderId || "");
		if (!dragId) return false;

		const hits = (
			String(order.original_id || "") === dragId
		);
		if (!hits) return false;

		const kind = String(drag.kind || "limit").toLowerCase();
		const role = String(order.role || "").toLowerCase();

		if (kind === "take_profit") return role === "take_profit";
		if (kind === "stop_loss") return role === "stop_loss";
		return !role;
	};

	getLiveDragLinePrice = (order, drag = this.state.openOrderDrag) => {
		const rowPrice = Number(order?.price);
		if (
			drag
			&& !drag.pending
			&& this.orderIsActiveDragTarget(order, drag)
		) {
			const pointerPrice = Number(drag.pointerPrice);
			if (Number.isFinite(pointerPrice) && pointerPrice > 0) return pointerPrice;
		}
		return rowPrice;
	};

	flashOpenOrderEditError = (handleKey) => {
		if (this.openOrderEditErrorFlashTimer) {
			window.clearTimeout(this.openOrderEditErrorFlashTimer);
			this.openOrderEditErrorFlashTimer = null;
		}

		this.setState({ openOrderEditErrorFlashKey: handleKey || "" });
		this.openOrderEditErrorFlashTimer = window.setTimeout(() => {
			this.openOrderEditErrorFlashTimer = null;
			this.setState(prev => (
				prev.openOrderEditErrorFlashKey === handleKey
					? { openOrderEditErrorFlashKey: "" }
					: null
			));
		}, OPEN_ORDER_EDIT_ERROR_FLASH_MS);
	};

	handleOpenOrderPriceDragStart = (event, handle) => {
		if (event.button != null && event.button !== 0) return;
		if (this.state.orderTicket || this.state.isOrderTicketClosing) return;
		if (this.isOrderTicketPriceDragging || this.isOpenOrderPriceDragging) return;
		if (!handle?.orderId || !handle?.kind) return;

		const order = this.findOpenOrderById(handle.orderId);
		if (!order || this.isOpenOrderMoveLocked(order)) return;
		if (!isOpenOrderStatus(order.status) || isErrorOrderStatus(order.status)) return;

		const size = this.getOpenOrderEditSize(order);
		if (!Number.isFinite(size) || size <= 0) return;

		const startPrice = Number(handle.price);
		if (!Number.isFinite(startPrice) || startPrice <= 0) return;

		event.preventDefault();
		event.stopPropagation();

		if (event.currentTarget?.setPointerCapture && event.pointerId != null) {
			try {
				event.currentTarget.setPointerCapture(event.pointerId);
				this.openOrderDragCaptureEl = event.currentTarget;
				this.openOrderDragPointerId = event.pointerId;
			} catch {
				this.openOrderDragCaptureEl = null;
				this.openOrderDragPointerId = null;
			}
		}

		const takeProfitPrice = Number(
			order.bracket_legs?.find(leg => leg.role === "take_profit")?.price
			?? order.price
		);
		const stopLossPrice = Number(
			order.bracket_legs?.find(leg => leg.role === "stop_loss")?.price
		);

		this.isOpenOrderPriceDragging = true;
		this.openOrderPriceDragGrabOffsetY = this.getPriceDragGrabOffsetY(event, startPrice);
		this.openOrderDragFrozenTotals = null;
		this.openOrderDragFrozenLimitTotal = null;
		const side = String(order.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";
		const confirmedUsd = this.getOrderConfirmedUsdNotional(order);
		const nextDrag = {
			orderId: handle.orderId,
			productId: order.product_id,
			kind: handle.kind,
			handleKey: handle.key,
			size,
			startPrice,
			pointerPrice: startPrice,
			takeProfitPrice: Number.isFinite(takeProfitPrice) ? takeProfitPrice : startPrice,
			stopLossPrice: Number.isFinite(stopLossPrice) ? stopLossPrice : null,
			orderType: String(order.order_type || "").toUpperCase(),
			side,
			confirmedUsd: (
				side === "BUY" && handle.kind === "limit" && confirmedUsd != null
					? confirmedUsd
					: null
			),
		};
		this.setOrderLineDisplayPlace("handleOpenOrderPriceDragStart");
		this.noteDragOwnerIfChanged("handleOpenOrderPriceDragStart", nextDrag);
		this.setState({
			openOrderDrag: nextDrag,
			openOrderEditErrorFlashKey: "",
		});
	};

	handleOpenOrderPriceDragMove = (event) => {
		if (!this.isOpenOrderPriceDragging || !this.candleSeries) return;

		const price = this.getPriceFromPointerEvent(
			event,
			this.openOrderPriceDragGrabOffsetY,
		);

		if (!Number.isFinite(price) || price <= 0) return;

		this.setState(prev => {
			if (!prev.openOrderDrag || prev.openOrderDrag.pending) return null;

			const fromPrice = Number(prev.openOrderDrag.pointerPrice);
			if (
				!Number.isFinite(fromPrice)
				|| fromPrice !== price
			) {
				this.setOrderLineDisplayPlace("handleOpenOrderPriceDragMove");
				this.logChartOrderLine("move", "handleOpenOrderPriceDragMove", {
					orderId: prev.openOrderDrag.orderId,
					originalId: prev.openOrderDrag.orderId,
					role: prev.openOrderDrag.kind || "limit",
					price,
				}, {
					fromPrice: Number.isFinite(fromPrice) ? fromPrice : null,
					toPrice: price,
				});
			}

			return {
				openOrderDrag: {
					...prev.openOrderDrag,
					pointerPrice: price,
				},
			};
		});
	};

	handleOpenOrderPriceDragEnd = () => {
		if (!this.isOpenOrderPriceDragging) return;

		const drag = this.state.openOrderDrag;
		this.isOpenOrderPriceDragging = false;
		this.openOrderPriceDragGrabOffsetY = 0;
		this.releaseOpenOrderPointerCapture();

		if (!drag || drag.pending) {
			this.openOrderDragFrozenTotals = null;
			this.openOrderDragFrozenLimitTotal = null;
			if (!drag?.pending) {
				this.setOrderLineDisplayPlace("handleOpenOrderPriceDragEnd.empty");
				this.noteDragOwnerIfChanged("handleOpenOrderPriceDragEnd.empty", null);
				this.setState({ openOrderDrag: null });
			}
			return;
		}

		const roundOrderPrice = (price) => {
			const rounded = Number(this.getOrderPriceInputValue(price));

			return Number.isFinite(rounded) && rounded > 0 ? rounded : NaN;
		};

		const pointerPrice = roundOrderPrice(drag.pointerPrice);
		const startPrice = roundOrderPrice(drag.startPrice);
		const unchanged = (
			!Number.isFinite(pointerPrice)
			|| (
				Number.isFinite(startPrice)
				&& pointerPrice === startPrice
			)
		);

		if (unchanged) {
			this.openOrderDragFrozenTotals = null;
			this.openOrderDragFrozenLimitTotal = null;
			this.setOrderLineDisplayPlace("handleOpenOrderPriceDragEnd.unchanged");
			this.noteDragOwnerIfChanged("handleOpenOrderPriceDragEnd.unchanged", null);
			this.setState({ openOrderDrag: null }, this.schedulePriceOverlayUpdate);
			return;
		}

		const body = {
			original_id: drag.orderId,
		};

		if (drag.kind === "limit") {
			body.price = pointerPrice;
		} else if (drag.kind === "take_profit") {
			body.price = pointerPrice;
			const stopLossPrice = roundOrderPrice(drag.stopLossPrice);
			if (!Number.isFinite(stopLossPrice)) {
				this.openOrderDragFrozenTotals = null;
				this.openOrderDragFrozenLimitTotal = null;
				this.setOrderLineDisplayPlace("handleOpenOrderPriceDragEnd.missingStop");
				this.noteDragOwnerIfChanged("handleOpenOrderPriceDragEnd.missingStop", null);
				this.setState({ openOrderDrag: null }, () => {
					this.schedulePriceOverlayUpdate();
					this.flashOpenOrderEditError(drag.handleKey);
					this.showChartNotice("Stop loss price missing for bracket edit.", { tone: "error" });
				});
				return;
			}
			body.stop_price = stopLossPrice;
		} else if (drag.kind === "stop_loss") {
			const takeProfitPrice = roundOrderPrice(drag.takeProfitPrice);
			if (!Number.isFinite(takeProfitPrice)) {
				this.openOrderDragFrozenTotals = null;
				this.openOrderDragFrozenLimitTotal = null;
				this.setOrderLineDisplayPlace("handleOpenOrderPriceDragEnd.missingTakeProfit");
				this.noteDragOwnerIfChanged("handleOpenOrderPriceDragEnd.missingTakeProfit", null);
				this.setState({ openOrderDrag: null }, () => {
					this.schedulePriceOverlayUpdate();
					this.flashOpenOrderEditError(drag.handleKey);
					this.showChartNotice("Take profit price missing for bracket edit.", { tone: "error" });
				});
				return;
			}
			body.price = takeProfitPrice;
			body.stop_price = pointerPrice;
		} else {
			this.setOrderLineDisplayPlace("handleOpenOrderPriceDragEnd.unknownKind");
			this.noteDragOwnerIfChanged("handleOpenOrderPriceDragEnd.unknownKind", null);
			this.setState({ openOrderDrag: null }, this.schedulePriceOverlayUpdate);
			return;
		}

		const pendingRequestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		const previousPrice = startPrice;

		this.setState(prev => {
			const allOrders = this.patchAllOrdersRow(
				prev.allOrders,
				drag.orderId,
				(order) => this.stampOpenOrderEditPending(
					order,
					drag,
					pointerPrice,
					pendingRequestId,
				) || order,
			);

			this.setOrderLineDisplayPlace("handleOpenOrderPriceDragEnd.send");
			this.diffChartOrderLines(
				prev.allOrders,
				allOrders,
				"handleOpenOrderPriceDragEnd.send",
			);

			this.noteDragOwnerIfChanged("handleOpenOrderPriceDragEnd.send", null, prev.openOrderDrag);

			return {
				openOrderDrag: null,
				allOrders,
			};
		}, this.schedulePriceOverlayUpdate);

		// Row as it was before the drop: moved leg back at previousPrice, no pending request.
		const restoreRow = (order, status) => enrichOrderForDisplay({
			...this.applyPointerPriceToOrder(order, drag, previousPrice),
			status,
			pending_request_id: null,
			pollsAfterMove: 0,
		});

		// The EDIT response is the only thing that settles a row carrying pending_request_id.
		const settleRow = (place, updater, notice) => {
			this.setState(prev => {
				const allOrders = this.patchAllOrdersRow(
					prev.allOrders,
					drag.orderId,
					(order) => (order ? updater(order) : order),
				);

				this.setOrderLineDisplayPlace(place);
				this.diffChartOrderLines(prev.allOrders, allOrders, place);

				return { allOrders };
			}, () => {
				this.schedulePriceOverlayUpdate();
				if (!notice) return;
				if (notice.tone === "error") this.flashOpenOrderEditError(drag.handleKey);
				this.showChartNotice(notice.message, { tone: notice.tone });
			});
		};

		api.editOrder(body)
			.then(response => {
				const updatedOrder = response.data?.order
					? enrichOrderForDisplay(response.data.order)
					: null;
				const updatedStatus = String(updatedOrder?.status || "").toUpperCase();

				if (updatedStatus === "OPEN") {
					settleRow(
						"handleOpenOrderPriceDragEnd.response.open",
						() => enrichOrderForDisplay({
							...updatedOrder,
							pending_request_id: null,
							pollsAfterMove: 0,
						}),
						{ tone: "success", message: "Order successfully updated" },
					);
					return;
				}

				if (updatedStatus === "PENDING") {
					settleRow(
						"handleOpenOrderPriceDragEnd.response.pending",
						(order) => enrichOrderForDisplay({
							...(updatedOrder || order),
							status: "PENDING",
							pending_request_id: null,
							pollsAfterMove: 0,
						}),
						null,
					);
					return;
				}

				if (updatedStatus === "ERROR") {
					settleRow(
						"handleOpenOrderPriceDragEnd.response.error",
						() => enrichOrderForDisplay({
							...updatedOrder,
							pending_request_id: null,
							pollsAfterMove: 0,
						}),
						{ tone: "error", message: "Unable to update order." },
					);
					return;
				}

				settleRow(
					"handleOpenOrderPriceDragEnd.response.unknown",
					(order) => restoreRow(order, "OPEN"),
					{
						tone: "error",
						message: `Unable to update order (unexpected response${updatedStatus ? ` ${updatedStatus}` : ""})`,
					},
				);
			})
			.catch((error) => {
				const httpStatus = Number(error?.response?.status);
				const detail = error?.response?.data?.detail;
				const code = Number.isFinite(httpStatus) && httpStatus > 0
					? `HTTP ${httpStatus}`
					: error?.code === "ECONNABORTED"
						? "ECONNABORTED (timeout 15s)"
						: error?.code === "ERR_NETWORK"
							? "ERR_NETWORK"
							: (error?.code || "NO_RESPONSE");

				if (httpStatus === 409) {
					settleRow(
						"handleOpenOrderPriceDragEnd.catch.409",
						(order) => restoreRow(order, "PENDING"),
						{
							tone: "error",
							message: "Move failed: a move for this order is already in progress (HTTP 409)",
						},
					);
					return;
				}

				const label = getOrderErrorLabel(detail || error?.message, "Unable to update order.");
				settleRow(
					"handleOpenOrderPriceDragEnd.catch",
					(order) => restoreRow(order, "OPEN"),
					{ tone: "error", message: `${label} (${code})` },
				);
			});
	};

	handleOrderTicketMoveDragStart = (event) => {
		if (event.button != null && event.button !== 0) return;
		if (!this.state.orderTicket) return;

		event.preventDefault();
		event.stopPropagation();

		const ticket = this.state.orderTicket;
		const style = this.getOrderTicketStyle(ticket);
		const rawAnchorOffsetY = ticket?.anchorOffsetY;
		const anchorOffsetY = rawAnchorOffsetY != null && Number.isFinite(Number(rawAnchorOffsetY))
			? Number(rawAnchorOffsetY)
			: ORDER_TICKET_ANCHOR_OFFSET_Y;

		this.isOrderTicketMoveDragging = true;
		this.orderTicketMoveDrag = {
			startClientY: event.clientY,
			startTop: Number(style?.top) || 0,
			anchorOffsetY,
		};
		this.setState({ isOrderTicketMoveDragging: true });
	};

	handleOrderTicketMoveDragMove = (event) => {
		if (
			!this.isOrderTicketMoveDragging
			|| !this.orderTicketMoveDrag
			|| !this.candleSeries
		) {
			return;
		}

		const nextTop = this.orderTicketMoveDrag.startTop
			+ (event.clientY - this.orderTicketMoveDrag.startClientY);
		const anchorScreenY = nextTop + this.orderTicketMoveDrag.anchorOffsetY;
		const price = this.candleSeries.coordinateToPrice(anchorScreenY);

		if (!Number.isFinite(price) || price <= 0) return;

		this.updateOrderTicket({
			anchorPrice: price,
			anchorOffsetY: this.orderTicketMoveDrag.anchorOffsetY,
		}, {
			schedulePreview: false,
		});
	};

	handleOrderTicketMoveDragEnd = () => {
		if (!this.isOrderTicketMoveDragging) return;

		this.isOrderTicketMoveDragging = false;
		this.orderTicketMoveDrag = null;
		this.setState({ isOrderTicketMoveDragging: false });
	};

	getOverlayMarketPrice = (state = this.state) => {
		const isOverlayMarketLoaded = (
			!state.isLoading
			&& Array.isArray(state.candles)
			&& state.candles.length > 0
		);

		if (!isOverlayMarketLoaded) {
			return NaN;
		}

		return Number(state.candles[state.candles.length - 1]?.close);
	};

	getLiveMarketPrice = () => this.getOverlayMarketPrice(this.state);

	getMarketPriceTickSize = () => {
		const increment = Number(this.state.product?.quote_increment);

		if (Number.isFinite(increment) && increment > 0) {
			return increment;
		}

		return PRICE_MIN_MOVE;
	};

	normalizeMarketPriceForCompare = (price) => {
		const numericPrice = Number(price);
		const tick = this.getMarketPriceTickSize();

		if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
			return NaN;
		}

		if (!Number.isFinite(tick) || tick <= 0) {
			return numericPrice;
		}

		return Math.round(numericPrice / tick) * tick;
	};

	isMarketOrderTicket = (ticket) => {
		if (!ticket) return false;

		return this.normalizeOrderTypeForSide(ticket.side, ticket.orderType) === "MARKET";
	};

	getStopLimitValidationError = (ticket) => {
		if (!ticket) return "";

		const side = ticket.side === "SELL" ? "SELL" : "BUY";
		const orderType = this.normalizeOrderTypeForSide(side, ticket.orderType);

		if (orderType !== "STOP_LIMIT") return "";

		const stopPrice = Number(ticket.stopPrice);
		const limitPrice = Number(ticket.price);
		const marketPrice = this.getLiveMarketPrice();

		if (!Number.isFinite(stopPrice) || stopPrice <= 0 || !Number.isFinite(limitPrice) || limitPrice <= 0) {
			return "";
		}

		if (side === "BUY") {
			if (Number.isFinite(marketPrice) && stopPrice <= marketPrice) {
				return "Stop price must be above the current price for buy stop orders.";
			}

			if (limitPrice < stopPrice) {
				return "Limit price must be at or above the stop price.";
			}
		} else {
			if (Number.isFinite(marketPrice) && stopPrice >= marketPrice) {
				return "Stop price must be below the current price for sell stop orders.";
			}

			if (limitPrice > stopPrice) {
				return "Limit price must be at or below the stop price.";
			}
		}

		return "";
	};

	getOrderTicketValidation = (ticket) => {
		if (!ticket) {
			return {
				isValid: false,
				error: "",
			};
		}

		const side = ticket.side === "SELL" ? "SELL" : "BUY";
		const orderType = this.normalizeOrderTypeForSide(side, ticket.orderType);
		const amount = Number(ticket.amount);
		const price = Number(ticket.price);
		const stopPrice = Number(ticket.stopPrice);
		const takeProfitPrice = Number(ticket.takeProfitPrice);
		const stopLossPrice = Number(ticket.stopLossPrice);
		const trailPercent = Number(ticket.trailPercent);

		if (!Number.isFinite(amount) || amount <= 0) {
			return {
				isValid: false,
				error: "",
			};
		}

		if (
			orderType !== "MARKET"
			&& orderType !== "BRACKET"
			&& !this.isTrailingOrderType(orderType)
			&& (!Number.isFinite(price) || price <= 0)
		) {
			return {
				isValid: false,
				error: "Enter a valid limit price.",
			};
		}

		if (orderType === "STOP_LIMIT" && (!Number.isFinite(stopPrice) || stopPrice <= 0)) {
			return {
				isValid: false,
				error: "Enter a valid stop price.",
			};
		}

		const stopLimitError = this.getStopLimitValidationError(ticket);

		if (stopLimitError) {
			return {
				isValid: false,
				error: stopLimitError,
			};
		}

		if (orderType === "BRACKET") {
			if (side !== "SELL") {
				return {
					isValid: false,
					error: "Bracket is only available for sell.",
				};
			}

			if (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0) {
				return {
					isValid: false,
					error: "Enter a valid TP price.",
				};
			}

			if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) {
				return {
					isValid: false,
					error: "Enter a valid SL price.",
				};
			}

			if (takeProfitPrice < stopLossPrice) {
				return {
					isValid: false,
					error: "TP must be at or above SL.",
				};
			}
		}

		if (this.isTrailingOrderType(orderType)) {
			if (side !== "SELL") {
				return {
					isValid: false,
					error: "Trailing is only available for sell.",
				};
			}

			if (!Number.isFinite(trailPercent) || trailPercent <= 0 || trailPercent >= 100) {
				return {
					isValid: false,
					error: "Trail percent must be greater than 0 and below 100.",
				};
			}
		}

		const sourceBalance = side === "BUY"
			? this.getBuyQuoteBalance()
			: this.getAvailableBalanceForSide(side);

		return {
			isValid: true,
			error: "",
			sourceCurrency: sourceBalance.currency,
		};
	};

	toggleOrderAmountMode = () => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		const amount = Number(ticket.amount);
		const nextMode = ticket.amountMode === "USD" ? "BASE" : "USD";
		const conversionPrice = this.getOrderReferencePrice(ticket);
		let nextAmount = ticket.amount;

		if (Number.isFinite(conversionPrice) && conversionPrice > 0 && Number.isFinite(amount) && amount > 0) {
			nextAmount = nextMode === "USD"
				? this.getOrderAmountInputValue({ ...ticket, amountMode: nextMode }, amount * conversionPrice)
				: this.getOrderAmountInputValue({ ...ticket, amountMode: nextMode }, amount / conversionPrice);
		}

		this.cancelOrderPreviewRequests();

		this.updateOrderTicket({
			...this.getOrderPreviewResetPatch(),
			amountMode: nextMode,
			amount: nextAmount,
			fraction: this.getOrderFractionFromAmount({
				...ticket,
				amountMode: nextMode,
			}, nextAmount),
		});
	};

	setOrderFraction = (fraction, options = {}) => {
		const ticket = this.state.orderTicket;
		const profile = options.profile || this.state.profile;

		if (!ticket || this.isOrderTicketZeroAvailable(ticket, profile)) return;

		const safeFraction = Number.isFinite(Number(fraction))
			? Math.max(0, Math.min(1, Number(fraction)))
			: 0;
		const maxAmount = this.getOrderMaxAmount(ticket, profile);
		const patch = {
			fraction: safeFraction,
			amount: maxAmount > 0
				? this.getOrderAmountInputValue(ticket, maxAmount * safeFraction)
				: "0",
		};

		if (options.schedulePreview === true) {
			this.cancelOrderPreviewRequests();
			Object.assign(patch, this.getOrderPreviewResetPatch());
		}

		this.updateOrderTicket(patch, { schedulePreview: options.schedulePreview === true });
	};

	applyOrderFractionPreset = (fraction) => {
		this.setOrderFraction(fraction, {
			schedulePreview: true,
		});
		this.loadProfile();
	};

	loadBalanceHistory = (period = this.state.balanceHistoryPeriod) => {
		const requestId = ++this.balanceHistoryRequestId;

		return api.getBalanceHistory({
			period,
			_: Date.now(),
		}).then(response => {
			if (requestId !== this.balanceHistoryRequestId) return;

			this.setState({
				balanceHistory: Array.isArray(response.data?.points) ? response.data.points : [],
				balanceHistoryPeriod: period,
				balanceHistoryLoadedPeriod: period,
				balanceHistoryLoading: false,
				balanceHistoryError: "",
			});
		}).catch(error => {
			if (requestId !== this.balanceHistoryRequestId) return;

			this.setState({
				balanceHistoryLoading: false,
				balanceHistoryError: error.response?.data?.detail || error.message || "Unable to load balance history.",
			});
		});
	};

	setBalanceHistoryPeriod = (period) => {
		const normalizedPeriod = normalizeBalanceHistoryPeriod(
			period,
			this.state.balanceHistoryPeriod,
		);

		if (normalizedPeriod === this.state.balanceHistoryPeriod) return;

		this.updateAppSettings({ balanceHistoryPeriod: normalizedPeriod });

		this.setState({
			balanceHistoryPeriod: normalizedPeriod,
			balanceHistoryLoading: true,
			balanceHistoryError: "",
		}, () => {
			this.loadBalanceHistory(normalizedPeriod);
		});
	};

	getOrderTicketPreviewError = (ticket) => {
		if (!ticket) return "Order ticket is closed.";

		const side = ticket.side === "SELL" ? "SELL" : "BUY";
		const orderType = this.normalizeOrderTypeForSide(side, ticket.orderType);
		const amount = Number(ticket.amount);
		const price = Number(ticket.price);
		const stopPrice = Number(ticket.stopPrice);
		const takeProfitPrice = Number(ticket.takeProfitPrice);
		const stopLossPrice = Number(ticket.stopLossPrice);
		const trailPercent = Number(ticket.trailPercent);

		if (!Number.isFinite(amount) || amount <= 0) {
			return "";
		}

		if (
			orderType !== "MARKET"
			&& orderType !== "BRACKET"
			&& !this.isTrailingOrderType(orderType)
			&& (!Number.isFinite(price) || price <= 0)
		) {
			return "Enter a valid limit price.";
		}

		if (orderType === "STOP_LIMIT" && (!Number.isFinite(stopPrice) || stopPrice <= 0)) {
			return "Enter a valid stop price.";
		}

		const stopLimitError = this.getStopLimitValidationError(ticket);

		if (stopLimitError) {
			return stopLimitError;
		}

		if (orderType === "BRACKET") {
			if (side !== "SELL") {
				return "Bracket is only available for sell.";
			}

			if (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0) {
				return "Enter a valid TP price.";
			}

			if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) {
				return "Enter a valid SL price.";
			}

			if (takeProfitPrice < stopLossPrice) {
				return "TP must be at or above SL.";
			}
		}

		if (this.isTrailingOrderType(orderType)) {
			if (side !== "SELL") {
				return "Trailing is only available for sell.";
			}

			if (!Number.isFinite(trailPercent) || trailPercent <= 0 || trailPercent >= 100) {
				return "Trail percent must be greater than 0 and below 100.";
			}
		}

		return "";
	};

	scheduleOrderPreview = () => {
		if (this.state.isOrderTicketClosing) return;

		const ticket = this.state.orderTicket;

		if (ticket && this.isMarketOrderTicket(ticket) && !(Number(ticket.amount) > 0)) {
			return;
		}

		if (this.orderPreviewTimer) {
			window.clearTimeout(this.orderPreviewTimer);
		}

		this.orderPreviewTimer = window.setTimeout(() => {
			this.orderPreviewTimer = null;
			this.refreshOrderPreview({ fromAmountChange: true });
		}, 350);
	};

	stopMarketPreviewPoller = () => {
		if (this.marketPreviewPollTimer) {
			window.clearTimeout(this.marketPreviewPollTimer);
			this.marketPreviewPollTimer = null;
		}
	};

	ensureMarketPreviewPoller = () => {
		const ticket = this.state.orderTicket;

		if (!ticket || !this.isMarketOrderTicket(ticket)) {
			this.stopMarketPreviewPoller();
			return;
		}

		if (this.marketPreviewPollTimer) {
			return;
		}

		this.marketPreviewPollTimer = window.setTimeout(() => {
			this.marketPreviewPollTimer = null;
			this.pollMarketOrderPreviewIfNeeded();
			this.ensureMarketPreviewPoller();
		}, MARKET_PREVIEW_POLL_INTERVAL_MS);
	};

	syncMarketPreviewPoller = () => {
		const ticket = this.state.orderTicket;
		const shouldPoll = Boolean(ticket && this.isMarketOrderTicket(ticket));

		if (!shouldPoll) {
			this.stopMarketPreviewPoller();
			return;
		}

		this.ensureMarketPreviewPoller();
	};

	pollMarketOrderPreviewIfNeeded = () => {
		const ticket = this.state.orderTicket;

		if (!ticket || !this.isMarketOrderTicket(ticket)) {
			return false;
		}

		if (!(Number(ticket.amount) > 0) || ticket.isPreviewLoading) {
			return false;
		}

		const now = Date.now();

		if (now - this.lastMarketPreviewAt < MARKET_PREVIEW_POLL_INTERVAL_MS) {
			return false;
		}

		const snapshotPrice = this.normalizeMarketPriceForCompare(ticket.previewMarketPrice);
		const overlayPrice = this.normalizeMarketPriceForCompare(this.getOverlayMarketPrice());

		if (!Number.isFinite(overlayPrice) || overlayPrice <= 0) {
			return false;
		}

		if (!Number.isFinite(snapshotPrice) || snapshotPrice <= 0) {
			return false;
		}

		if (snapshotPrice === overlayPrice) {
			return false;
		}

		this.refreshOrderPreview({ fromMarketPricePoll: true });
		return true;
	};

	flushOrderPreview = () => {
		if (this.orderPreviewTimer) {
			window.clearTimeout(this.orderPreviewTimer);
			this.orderPreviewTimer = null;
		}

		this.refreshOrderPreview({ fromAmountChange: true });
	};

	cancelOrderPreviewRequests = () => {
		this.orderPreviewRequestId += 1;

		if (this.orderPreviewTimer) {
			window.clearTimeout(this.orderPreviewTimer);
			this.orderPreviewTimer = null;
		}
	};

	getOrderPreviewResetPatch = () => ({
		preview: null,
		previewBodyKey: "",
		previewError: "",
		previewMarketPrice: null,
		previewEnteredAmount: null,
		previewRequestedAt: null,
		isPreviewLoading: false,
	});

	stopOrderPreviewWaitTicker = () => {
		if (this.orderPreviewWaitTimer) {
			window.clearInterval(this.orderPreviewWaitTimer);
			this.orderPreviewWaitTimer = null;
		}
	};

	ensureOrderPreviewWaitTicker = () => {
		if (this.orderPreviewWaitTimer) return;

		this.orderPreviewWaitTimer = window.setInterval(() => {
			const ticket = this.state.orderTicket;

			if (!ticket?.isPreviewLoading || !ticket?.previewRequestedAt) {
				this.stopOrderPreviewWaitTicker();
				return;
			}

			this.setState(prev => ({
				overlayTick: prev.overlayTick + 1,
			}));
		}, 1000);
	};

	getOrderPreviewWaitSeconds = (ticket = this.state.orderTicket) => {
		const requestedAt = Number(ticket?.previewRequestedAt);

		if (!ticket?.isPreviewLoading || !Number.isFinite(requestedAt) || requestedAt <= 0) {
			return null;
		}

		return Math.max(0, Math.floor((Date.now() - requestedAt) / 1000));
	};

	getOrderTicketPreviewBodyKey = (ticket, responseData) => {
		if (!ticket || !responseData) return "";

		const build = this.buildOrderTicketBody({
			...ticket,
			preview: responseData,
			previewEnteredAmount: ticket.amount,
		}, { forPreview: true });

		return build.body ? JSON.stringify(build.body) : "";
	};

	finishOrderPreview = (requestId, bodyKey, responseData) => {
		if (requestId !== this.orderPreviewRequestId) return false;

		if (this.state.isOrderTicketClosing) return false;

		const currentTicket = this.state.orderTicket;

		if (!currentTicket) return false;

		const acceptedBodyKey = this.getOrderTicketPreviewBodyKey(currentTicket, responseData);

		if (!acceptedBodyKey) {
			this.updateOrderTicket({
				previewRequestedAt: null,
				isPreviewLoading: false,
			}, {
				schedulePreview: false,
				onCommitted: () => this.stopOrderPreviewWaitTicker(),
			});
			return false;
		}

		const errs = Array.isArray(responseData?.errs) ? responseData.errs : [];
		const previewError = errs.length && !this.isSellZeroBalanceTicket(currentTicket)
			? getOrderErrorLabel({ errs }, "Unable to preview Coinbase order.", {
				side: currentTicket.side,
				orderType: this.normalizeOrderTypeForSide(currentTicket.side, currentTicket.orderType),
			})
			: "";
		const previewMarketPrice = Number.isFinite(Number(this.marketPreviewRequestPrice))
			&& Number(this.marketPreviewRequestPrice) > 0
			? Number(this.marketPreviewRequestPrice)
			: this.getOverlayMarketPrice();

		this.marketPreviewRequestPrice = null;

		this.updateOrderTicket({
			preview: responseData,
			previewBodyKey: acceptedBodyKey,
			previewError,
			previewMarketPrice: this.isMarketOrderTicket(currentTicket) ? previewMarketPrice : null,
			previewEnteredAmount: currentTicket.amount,
			previewRequestedAt: null,
			isPreviewLoading: false,
		}, {
			schedulePreview: false,
			onCommitted: () => {
				this.stopOrderPreviewWaitTicker();
				if (this.isMarketOrderTicket(this.state.orderTicket)) {
					this.stopMarketPreviewPoller();
					this.ensureMarketPreviewPoller();
				}
			},
		});

		return true;
	};

	refreshOrderPreview = (options = {}) => {
		if (this.state.isOrderTicketClosing) return;

		const ticket = this.state.orderTicket;

		if (!ticket || ticket.isSubmitting) return;

		if (this.isOrderTicketZeroAvailable(ticket)) {
			this.updateOrderTicket({
				...this.getOrderPreviewResetPatch(),
				previewError: "",
			}, { schedulePreview: false });
			return;
		}

		const stopLimitError = this.getStopLimitValidationError(ticket);

		if (stopLimitError) {
			this.updateOrderTicket({
				preview: null,
				previewBodyKey: "",
				previewError: stopLimitError,
				previewMarketPrice: null,
				previewRequestedAt: null,
				isPreviewLoading: false,
			}, {
				schedulePreview: false,
				onCommitted: () => this.stopOrderPreviewWaitTicker(),
			});
			return;
		}

		const previewError = this.getOrderTicketPreviewError(ticket);

		if (previewError) {
			this.updateOrderTicket({
				preview: null,
				previewBodyKey: "",
				previewError: previewError === "" ? "" : previewError,
				previewMarketPrice: null,
				previewRequestedAt: null,
				isPreviewLoading: false,
			}, {
				schedulePreview: false,
				onCommitted: () => this.stopOrderPreviewWaitTicker(),
			});
			return;
		}

		const displayBuild = this.buildOrderTicketBody(ticket, { forPreview: true });
		const displayBodyKey = displayBuild.body ? JSON.stringify(displayBuild.body) : "";
		const isMarketTicket = this.isMarketOrderTicket(ticket);
		const isPricePollRequest = options.fromMarketPricePoll === true;
		const isAmountChangeRequest = options.fromAmountChange === true;

		if (isMarketTicket) {
			if (!isPricePollRequest && !isAmountChangeRequest) {
				return;
			}

			if (
				isAmountChangeRequest
				&& ticket.preview
				&& !ticket.previewError
				&& ticket.previewEnteredAmount !== null
				&& String(ticket.previewEnteredAmount) === String(ticket.amount)
			) {
				return;
			}
		} else if (
			ticket.preview
			&& !ticket.previewError
			&& ticket.previewBodyKey === displayBodyKey
		) {
			return;
		}

		const probeTicket = {
			...ticket,
			preview: null,
			previewEnteredAmount: null,
			previewBodyKey: "",
			previewError: "",
		};
		const orderBuild = this.buildOrderTicketBody(probeTicket, { forPreview: true });

		if (!orderBuild.body) {
			this.updateOrderTicket({
				preview: null,
				previewBodyKey: "",
				previewError: "",
				previewMarketPrice: null,
				previewRequestedAt: null,
				isPreviewLoading: false,
			}, {
				schedulePreview: false,
				onCommitted: () => this.stopOrderPreviewWaitTicker(),
			});
			return;
		}

		const body = orderBuild.body;
		const bodyKey = JSON.stringify(body);

		if (isMarketTicket) {
			this.marketPreviewRequestPrice = this.getOverlayMarketPrice();
			this.lastMarketPreviewAt = Date.now();
			this.stopMarketPreviewPoller();
		}

		const requestId = this.orderPreviewRequestId + 1;
		this.orderPreviewRequestId = requestId;

		this.updateOrderTicket({
			isPreviewLoading: true,
			previewRequestedAt: Date.now(),
			previewError: "",
		}, {
			schedulePreview: false,
			onCommitted: () => this.ensureOrderPreviewWaitTicker(),
		});

		api.previewOrder(body)
			.then(response => {
				this.finishOrderPreview(requestId, bodyKey, response.data);
			})
			.catch(error => {
				if (requestId !== this.orderPreviewRequestId) return;

				const detail = error.response?.data?.detail;

				if (detail?.preview) {
					this.finishOrderPreview(requestId, bodyKey, {
						...detail.preview,
						errs: detail.errs || detail.preview.errs || [],
					});
					return;
				}

				this.updateOrderTicket({
					preview: null,
					previewBodyKey: "",
					previewError: getOrderErrorLabel(
						detail || error.message || "Unable to preview Coinbase order.",
						"Unable to preview Coinbase order.",
						{
							side: ticket.side,
							orderType: this.normalizeOrderTypeForSide(ticket.side, ticket.orderType),
						},
					),
					previewMarketPrice: null,
					previewRequestedAt: null,
					isPreviewLoading: false,
				}, {
					schedulePreview: false,
					onCommitted: () => this.stopOrderPreviewWaitTicker(),
				});
			});
	};

	buildOrderTicketBody = (ticket = this.state.orderTicket, { forPreview = false } = {}) => {
		if (!ticket) {
			return {
				body: null,
				error: "Order ticket is closed.",
			};
		}

		const side = ticket.side === "SELL" ? "SELL" : "BUY";
		const orderType = this.normalizeOrderTypeForSide(side, ticket.orderType);
		const price = Number(ticket.price);
		const formattedLimitPrice = Number(this.getOrderPriceInputValue(price));
		const formattedStopPrice = Number(this.getOrderPriceInputValue(Number(ticket.stopPrice)));
		const referencePrice = this.getOrderReferencePrice({ ...ticket, side, orderType });
		const amount = Number(ticket.amount);
		const baseCurrency = this.state.baseCurrency.trim().toUpperCase();

		if (orderType !== ticket.orderType) {
			return {
				body: null,
				patch: { orderType },
				error: "Order type was invalid for this side. Review and submit again.",
			};
		}

		if (!baseCurrency || !Number.isFinite(amount) || amount <= 0) {
			return {
				body: null,
				error: "Enter a valid amount.",
			};
		}

		let quoteCurrency = "USDC";

		if (forPreview) {
			const previewError = this.getOrderTicketPreviewError(ticket);

			if (previewError) {
				return {
					body: null,
					error: previewError,
				};
			}

			if (side === "BUY") {
				quoteCurrency = this.getBuyQuoteBalance().currency || "USDC";
			}
		} else {
			const validation = this.getOrderTicketValidation(ticket);

			if (!validation.isValid) {
				return {
					body: null,
					error: validation.error || "Check order values.",
				};
			}

			quoteCurrency = side === "BUY"
				? validation.sourceCurrency || "USDC"
				: "USDC";
		}

		const body = {
			product_id: `${baseCurrency}-${quoteCurrency}`,
			side,
			order_type: orderType,
			base_size: ticket.amountMode === "USD" && side === "SELL" && Number.isFinite(referencePrice) && referencePrice > 0
				? amount / referencePrice
				: ticket.amountMode === "USD" && side === "BUY"
					? undefined
					: amount,
		};

		if (ticket.amountMode === "USD" && side === "BUY") {
			body.quote_size = getBuyUsdPreviewQuoteSize(amount);
			delete body.base_size;
		}

		if (orderType === "LIMIT") {
			body.limit_price = formattedLimitPrice;
		}

		if (orderType === "STOP_LIMIT") {
			body.limit_price = formattedLimitPrice;
			body.stop_price = formattedStopPrice;
		}

		if (orderType === "BRACKET") {
			body.take_profit_price = Number(ticket.takeProfitPrice);
			body.stop_loss_price = Number(ticket.stopLossPrice);
		}

		if (this.isTrailingOrderType(orderType)) {
			body.trail_percent = Number(ticket.trailPercent);
		}

		if (orderType === "BRACKET" && ticket.amountMode === "USD") {
			delete body.quote_size;
			body.base_size = amount / Number(ticket.takeProfitPrice);
		}

		return {
			body,
			error: "",
		};
	};

	submitOrderTicket = () => {
		const ticket = this.state.orderTicket;
		if (!ticket || ticket.isSubmitting) return;

		const orderBuild = this.buildOrderTicketBody(ticket);

		if (!orderBuild.body) {
			this.updateOrderTicket({
				...(orderBuild.patch || {}),
				error: orderBuild.error || "Check order values.",
			}, { schedulePreview: false });
			return;
		}

		const body = orderBuild.body;
		const bodyKey = JSON.stringify(body);
		const preview = ticket.preview;
		const previewId = preview?.preview_id;
		const hasValidPreview = preview && ticket.previewBodyKey === bodyKey && !ticket.previewError;

		const placeBody = { ...body };
		const orderType = String(placeBody.order_type || "").toUpperCase();
		const isBuy = String(placeBody.side || "").toUpperCase() === "BUY";
		const previewQuoteSize = Number(preview?.quote_size);

		if (
			hasValidPreview
			&& isBuy
			&& (orderType === "LIMIT" || orderType === "STOP_LIMIT")
			&& Number.isFinite(previewQuoteSize)
			&& previewQuoteSize > 0
		) {
			placeBody.quote_size = previewQuoteSize;
			delete placeBody.base_size;
		}

		this.updateOrderTicket({ isSubmitting: true, error: "" }, { schedulePreview: false });

		api.placeOrder({
			...placeBody,
			...(hasValidPreview
				? {
					preview_id: previewId,
					preview_base_size: preview?.base_size,
					preview_order_total: preview?.order_total,
					preview_commission_total: preview?.commission_total,
					preview_quote_size: preview?.quote_size,
				}
				: {}),
		})
			.then((response) => {
				const closingTicket = this.state.orderTicket;
				const placedOrder = response?.data?.order
					? enrichOrderForDisplay(response.data.order)
					: null;

				if (
					this.isTrailingOrderType(orderType)
					&& Number.isFinite(Number(placeBody.trail_percent))
					&& Number(placeBody.trail_percent) > 0
					&& Number(placeBody.trail_percent) < 100
				) {
					setCookieValue(TRAILING_PERCENT_COOKIE, String(placeBody.trail_percent));
				}

				this.prepareOrderTicketClose();

				this.setState(prev => {
					const ticket = prev.orderTicket;
					const next = {};

					if (placedOrder) {
						next.allOrders = uniqueOrdersByOriginalId(
							this.mergeOrderUpdates(prev.allOrders, [placedOrder]),
						);
						this.diffChartOrderLines(
							prev.allOrders,
							next.allOrders,
							"submitOrderTicket.placed",
						);
					}

					if (ticket) {
						next.isOrderTicketClosing = true;
						next.lastOrderSide = ticket.side === "SELL" ? "SELL" : "BUY";
						next.savedOrderTickets = {
							...prev.savedOrderTickets,
							[ticket.side]: this.getSavedOrderSnapshot(ticket),
						};
						next.orderScaleHover = null;
					}

					return Object.keys(next).length ? next : null;
				}, () => {
					if (closingTicket) {
						this.scheduleOrderTicketCloseEnd();
					}

					this.scheduleOverlayUpdate();
					this.showChartNotice("Order successfully placed", { tone: "success" });
					this.loadAllOrders({ force: true });
				});
			})
			.catch(error => {
				const detail = error.response?.data?.detail || error.message || "Unable to place Coinbase order.";

				this.updateOrderTicket({
					isSubmitting: false,
					error: getOrderErrorLabel(detail, "Unable to place Coinbase order.", {
						side: ticket.side,
						orderType: this.normalizeOrderTypeForSide(ticket.side, ticket.orderType),
					}),
				}, { schedulePreview: false });
			});
	};

	cancelOrder = (order, event) => {
		event.preventDefault();
		event.stopPropagation();

		const orderId = order?.original_id;

		if (!orderId) {
			this.setState({ orderError: "Unable to cancel order: missing order id." });
			return;
		}

		this.setState({ orderError: "" });

		api.cancelOrder(orderId).then(() => {
			this.setState(prev => {
				const allOrders = (prev.allOrders || []).filter(item => (
					String(item?.original_id || "") !== String(orderId)
				));

				this.diffChartOrderLines(prev.allOrders, allOrders, "cancelOrder");

				return {
					allOrders,
					orderError: "",
				};
			}, this.scheduleOverlayUpdate);
			this.loadAllOrders({ force: true });
		}).catch(error => {
			this.setState({
				orderError: error.response?.data?.detail || error.message || "Unable to cancel Coinbase order.",
			});
		});
	};

	syncCurrencyPath = (baseCurrency) => {
		const nextPath = `${getRoutePrefix(this.props.history.pathname)}/${baseCurrency}`;

		if (this.props.history.pathname !== nextPath) {
			this.props.navigate(nextPath);
		}
	};

	toggleIndicator = (key) => {
		const stateKeyByIndicator = {
			depth: "showDepthIndicator",
			td: "showTdIndicator",
			vwap: "showVwapIndicator",
			volh: "showVolhIndicator",
			prch: "showPrchIndicator",
			macd: "showMacdIndicator",
			pvt: "showPvtIndicator",
			lims24: "showLims24Indicator",
			bag: "showBagValueIndicator",
		};
		const stateKey = stateKeyByIndicator[key];
		const cookieName = INDICATOR_COOKIES[key];

		if (!stateKey || !cookieName) return;

		this.setState(prev => {
			const nextValue = !prev[stateKey];

			setCookieBoolean(cookieName, nextValue);

			return { [stateKey]: nextValue };
		});
	};

	toggleHud = () => {
		this.setState(prev => {
			const nextValue = !prev.showHud;
			setCookieBoolean(HUD_COOKIE, nextValue);
			return { showHud: nextValue };
		});
	};

	applyIndicatorVisibility = () => {
		this.tdSequentialSeries?.applyOptions({ visible: this.state.showTdIndicator });
		this.vwapSeries.forEach(series => series.applyOptions({ visible: this.state.showVwapIndicator }));
		this.scheduleOverlayUpdate();
	};

	formatChartPrice = (price) => (
		hasPriceIncrement(this.state.product?.quote_increment)
			? formatDisplayPriceWithIncrement(price, this.state.product.quote_increment)
			: "--"
	);

	formatOverlayPriceForProduct = (price) => (
		hasPriceIncrement(this.state.product?.quote_increment)
			? formatDisplayPriceWithIncrement(price, this.state.product.quote_increment)
			: formatOverlayPrice(price)
	);

	getOverlayLabelLayout = (label, lineRight) => {
		const text = String(label || "");
		let textWidth = this.overlayTextWidthCache.get(text);

		if (!Number.isFinite(textWidth)) {
			if (!this.overlayTextMeasureContext && typeof document !== "undefined") {
				this.overlayTextMeasureContext = document.createElement("canvas").getContext("2d");
			}

			if (this.overlayTextMeasureContext) {
				this.overlayTextMeasureContext.font = "750 11px Inter";
				textWidth = this.overlayTextMeasureContext.measureText(text).width;
			} else {
				textWidth = text.length * 6.25;
			}

			this.overlayTextWidthCache.set(text, textWidth);
		}

		const textX = lineRight - 12 - textWidth;

		return {
			actionX: textX - 11,
			textX,
		};
	};

	getPriceViewportRange = () => {
		const range = this.getMainPriceScale()?.getVisibleRange?.();
		const from = Number(range?.from);
		const to = Number(range?.to);

		if (Number.isFinite(from) && Number.isFinite(to)) {
			const min = Math.min(from, to);
			const max = Math.max(from, to);

			if (max > min) {
				this.lastPriceViewportRange = { min, max };
				return this.lastPriceViewportRange;
			}
		}

		const last = this.lastPriceViewportRange;

		if (last && last.max > last.min) return last;

		return null;
	};

	syncPriceScaleMinMoveFromViewport = () => {
		if (this.priceScaleMinMoveSyncFrame) return;

		this.priceScaleMinMoveSyncFrame = requestAnimationFrame(() => {
			this.priceScaleMinMoveSyncFrame = null;
			this.applyPriceSeriesFormat();
		});
	};

	getPriceScaleMinMoveDebug = () => {
		const viewport = this.getPriceViewportRange();
		const visible = this.getMainPriceScale()?.getVisibleRange?.();
		const quoteIncrement = Number(this.state.product?.quote_increment);
		const floor = 1e-9;
		const span = viewport ? (viewport.max - viewport.min) : NaN;
		const raw = Number.isFinite(span) && span > 0 ? span / 2000 : NaN;
		const fallback = !Number.isFinite(raw) || !(raw > 0);
		let snapped = null;
		let exp = null;
		let minMove;

		if (fallback) {
			// Never fall back to PRICE_MIN_MOVE (1e-6) — that locks PEPE to two labels.
			const kept = Number(this.lastPriceScaleMinMove);
			minMove = Number.isFinite(kept) && kept > 0 ? kept : floor;
		} else {
			exp = Math.floor(Math.log10(raw));
			snapped = exp >= 0 ? 10 ** exp : 1 / (10 ** (-exp));
			minMove = Math.max(snapped, floor);
		}

		return {
			minMove,
			raw,
			snapped,
			exp,
			floor,
			fallback,
			kept_minMove: Number.isFinite(Number(this.lastPriceScaleMinMove))
				? Number(this.lastPriceScaleMinMove)
				: null,
			PRICE_MIN_MOVE,
			quote_increment: Number.isFinite(quoteIncrement) ? quoteIncrement : null,
			viewport_min: viewport?.min ?? null,
			viewport_max: viewport?.max ?? null,
			viewport_span: Number.isFinite(span) ? span : null,
			getVisibleRange_from: Number.isFinite(Number(visible?.from)) ? Number(visible.from) : null,
			getVisibleRange_to: Number.isFinite(Number(visible?.to)) ? Number(visible.to) : null,
			lastPriceViewportRange: this.lastPriceViewportRange
				? { ...this.lastPriceViewportRange }
				: null,
		};
	};

	getPriceScaleMinMove = () => this.getPriceScaleMinMoveDebug().minMove;

	getPriceSeriesFormat = () => ({
		type: 'custom',
		minMove: this.getPriceScaleMinMove(),
		formatter: this.formatChartPrice,
	});

	applyPriceSeriesFormat = () => {
		const minMoveDebug = this.getPriceScaleMinMoveDebug();
		const priceFormat = {
			type: 'custom',
			minMove: minMoveDebug.minMove,
			formatter: this.formatChartPrice,
		};

		if (Number.isFinite(minMoveDebug.minMove) && minMoveDebug.minMove > 0) {
			this.lastPriceScaleMinMove = minMoveDebug.minMove;
		}

		this.candleSeries?.applyOptions({ priceFormat });
		this.tdSequentialSeries?.applyOptions({ priceFormat });
		this.vwapSeries.forEach(series => series.applyOptions({ priceFormat }));
	};

	normalizeCandles = (data) => {
		if (!Array.isArray(data)) return [];

		return data.map(candle => ({
			time: Number(candle.time),
			open: Number(candle.open),
			high: Number(candle.high),
			low: Number(candle.low),
			close: Number(candle.close),
			volume: Number(candle.volume),
		})).filter(candle => (
			Number.isFinite(candle.time)
			&& Number.isFinite(candle.open)
			&& Number.isFinite(candle.high)
			&& Number.isFinite(candle.low)
			&& Number.isFinite(candle.close)
		));
	};

	buildDistribution = (candles = this.state.candles) => {
		if (!candles.length) {
			return {
				bins: [],
				maxValue: 0,
				maxCountValue: 0,
			};
		}

		const minPrice = Math.min(...candles.map(candle => candle.low));
		const maxPrice = Math.max(...candles.map(candle => candle.high));

		if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
			return {
				bins: [],
				maxValue: 0,
				maxCountValue: 0,
			};
		}

		const step = (maxPrice - minPrice) / DISTRIBUTION_BINS || 1;
		const quoteIncrement = Number(this.state.product?.quote_increment);
		const hasIncrement = hasPriceIncrement(quoteIncrement) && quoteIncrement > 0;
		const precision = hasIncrement
			? getPrecisionFromIncrement(quoteIncrement)
			: null;

		const snapToTick = (price) => {
			if (!hasIncrement) return price;

			const tick = Math.round(price / quoteIncrement);
			return Number((tick * quoteIncrement).toFixed(precision));
		};

		const rawBins = Array.from({ length: DISTRIBUTION_BINS }, (_, index) => ({
			price: snapToTick(minPrice + step * (index + 0.5)),
			volumeValue: 0,
			countValue: 0,
		}));

		candles.forEach(candle => {
			const candleLow = Math.min(candle.low, candle.high);
			const candleHigh = Math.max(candle.low, candle.high);
			const startIndex = Math.max(
				0,
				Math.min(DISTRIBUTION_BINS - 1, Math.floor((candleLow - minPrice) / step)),
			);
			const endIndex = Math.max(
				startIndex,
				Math.min(DISTRIBUTION_BINS - 1, Math.floor((candleHigh - minPrice) / step)),
			);
			const touchedBins = endIndex - startIndex + 1;
			const volumeValuePerBin = (candle.volume || 1) / touchedBins;
			const countValuePerBin = 1 / touchedBins;

			for (let index = startIndex; index <= endIndex; index += 1) {
				rawBins[index].volumeValue += volumeValuePerBin;
				rawBins[index].countValue += countValuePerBin;
			}
		});

		// Merge adjacent bins that snapped to the same valid tick.
		const bins = [];

		rawBins.forEach((bin) => {
			const previous = bins[bins.length - 1];

			if (previous && previous.price === bin.price) {
				previous.volumeValue += bin.volumeValue;
				previous.countValue += bin.countValue;
				return;
			}

			bins.push({ ...bin });
		});

		const maxValue = Math.max(...bins.map(bin => bin.volumeValue), 0);
		const maxCountValue = Math.max(...bins.map(bin => bin.countValue), 0);

		return { bins, maxValue, maxCountValue };
	};

	getCachedDistribution = () => {
		const candles = this.state.historicalCandles;
		const increment = this.state.product?.quote_increment;

		if (!Array.isArray(candles) || !candles.length) {
			return { bins: [], maxValue: 0, maxCountValue: 0 };
		}

		// Wait for tick size — never build once without it, then rebuild after product loads.
		if (!hasPriceIncrement(increment)) {
			return { bins: [], maxValue: 0, maxCountValue: 0 };
		}

		const key = [
			candles.length,
			candles[0]?.time,
			candles[candles.length - 1]?.time,
			String(increment),
		].join("|");

		if (this.cachedDistribution && this.cachedDistributionKey === key) {
			return this.cachedDistribution;
		}

		this.cachedDistributionKey = key;
		this.cachedDistribution = this.buildDistribution(candles);
		return this.cachedDistribution;
	};

	priceToY = (price) => {
		if (!this.candleSeries) return null;

		const coordinate = this.candleSeries.priceToCoordinate(price);
		return Number.isFinite(coordinate) ? coordinate : null;
	};

	getOrderTicketStyle = (orderTicket) => {
		const chartHeight = this.state.chartSize.height || 0;
		const chartWidth = this.state.chartSize.width || 0;
		const right = ORDER_TICKET_RIGHT_OFFSET;
		const fallbackTicketWidth = 262;
		const ticketRect = this.orderTicketRef.current?.getBoundingClientRect?.();
		const chartRect = this.chartRef.current?.getBoundingClientRect?.();
		const ticketWidth = Math.ceil(ticketRect?.width || fallbackTicketWidth);
		const measuredTicketHeight = Number(ticketRect?.height);
		const ticketHeight = Number.isFinite(measuredTicketHeight) && measuredTicketHeight > 0
			? Math.ceil(measuredTicketHeight)
			: ORDER_TICKET_FALLBACK_HEIGHT;
		const ticketLeft = chartWidth - right - ticketWidth;
		const ticketRight = chartWidth - right;
		const padding = 12;
		let topBoundary = padding;
		let bottomBoundary = Math.max(padding + ticketHeight, chartHeight - padding);

		const overlapsTicketX = (element) => {
			const elementRect = element?.getBoundingClientRect?.();

			if (!elementRect || !chartRect) return false;

			const elementLeft = elementRect.left - chartRect.left;
			const elementRight = elementRect.right - chartRect.left;

			return elementRight >= ticketLeft - padding && elementLeft <= ticketRight + padding;
		};
		const applyBlockClamp = (element, direction) => {
			const elementRect = element?.getBoundingClientRect?.();

			if (!elementRect || !chartRect || !overlapsTicketX(element)) return;

			const elementTop = elementRect.top - chartRect.top;
			const elementBottom = elementRect.bottom - chartRect.top;

			if (direction === "top") {
				topBoundary = Math.max(topBoundary, elementBottom + padding);
			} else {
				bottomBoundary = Math.min(bottomBoundary, elementTop - padding);
			}
		};

		applyBlockClamp(this.chartBottomControlsRef.current, "top");
		applyBlockClamp(this.indicatorTogglesRef.current, "bottom");

		const rawAnchorPrice = orderTicket?.anchorPrice;
		const anchorPrice = Number(rawAnchorPrice);
		const anchorCoordinate = (
			rawAnchorPrice != null
			&& Number.isFinite(anchorPrice)
			&& anchorPrice > 0
		)
			? this.priceToY(anchorPrice)
			: null;
		const anchorY = Number.isFinite(anchorCoordinate)
			? anchorCoordinate
			: Number.isFinite(Number(orderTicket?.anchorY))
				? Number(orderTicket.anchorY)
				: chartHeight / 2;
		const rawAnchorOffsetY = orderTicket?.anchorOffsetY;
		const anchorOffsetY = rawAnchorOffsetY != null && Number.isFinite(Number(rawAnchorOffsetY))
			? Number(rawAnchorOffsetY)
			: ORDER_TICKET_ANCHOR_OFFSET_Y;
		const desiredTop = anchorY - anchorOffsetY;
		const maxTop = Math.max(topBoundary, bottomBoundary - ticketHeight);
		const top = Math.min(Math.max(desiredTop, topBoundary), maxTop);

		return {
			right,
			top,
		};
	};

	timeToX = (time) => {
		if (!this.chart) return null;

		const coordinate = this.chart.timeScale().timeToCoordinate(toChartTime(time));
		if (Number.isFinite(coordinate)) return coordinate;

		const { candles } = this.state;
		const numericTime = Number(time);

		if (!candles.length || !Number.isFinite(numericTime)) return null;

		const upperIndex = candles.findIndex(candle => candle.time >= numericTime);

		if (upperIndex === -1) {
			const lastIndex = candles.length - 1;
			const last = candles[lastIndex];
			const step = this.getCandleIntervalStep(candles, lastIndex);
			const logical = lastIndex + (numericTime - last.time) / step;
			const fallbackCoordinate = this.chart.timeScale().logicalToCoordinate?.(logical);

			return Number.isFinite(fallbackCoordinate) ? fallbackCoordinate : null;
		}

		if (upperIndex === 0) {
			const first = candles[0];
			const step = this.getCandleIntervalStep(candles, 1);
			const logical = (numericTime - first.time) / step;
			const fallbackCoordinate = this.chart.timeScale().logicalToCoordinate?.(logical);

			return Number.isFinite(fallbackCoordinate) ? fallbackCoordinate : null;
		}

		const previous = candles[upperIndex - 1];
		const next = candles[upperIndex];
		const span = next.time - previous.time;
		const logical = span
			? upperIndex - 1 + (numericTime - previous.time) / span
			: upperIndex;
		const fallbackCoordinate = this.chart.timeScale().logicalToCoordinate?.(logical);

		return Number.isFinite(fallbackCoordinate) ? fallbackCoordinate : null;
	};

	getCandleIntervalStep = (candles = this.state.candles, index = candles.length - 1) => {
		if (!Array.isArray(candles) || candles.length < 2) return 60;

		const clampedIndex = Math.min(candles.length - 1, Math.max(1, index));
		const step = Number(candles[clampedIndex].time) - Number(candles[clampedIndex - 1].time);

		return Number.isFinite(step) && step > 0 ? step : 60;
	};

	logicalToTime = (logical) => {
		const { candles } = this.state;

		if (!candles.length || !Number.isFinite(logical)) return null;
		if (candles.length === 1) return candles[0].time;

		const lowerIndex = Math.floor(logical);
		const upperIndex = Math.ceil(logical);
		const getTimeAtIndex = (index) => {
			if (candles[index]) return candles[index].time;

			if (index < 0) {
				const step = this.getCandleIntervalStep(candles, candles.length - 1);
				return candles[0].time + index * step;
			}

			const lastIndex = candles.length - 1;
			const step = this.getCandleIntervalStep(candles, lastIndex);

			return candles[lastIndex].time + (index - lastIndex) * step;
		};
		const lowerTime = getTimeAtIndex(lowerIndex);
		const upperTime = getTimeAtIndex(upperIndex);

		if (lowerIndex === upperIndex) return lowerTime;

		return lowerTime + (upperTime - lowerTime) * (logical - lowerIndex);
	};

	measurementCandleScreenX = (index) => {
		const candles = this.plottedCandles;
		const candle = Array.isArray(candles) ? candles[index] : null;

		if (!candle || !this.chart) return null;

		const coordinate = this.chart.timeScale().timeToCoordinate(toChartTime(candle.time));
		return Number.isFinite(coordinate) ? coordinate : null;
	};

	// Project saved MT time → screen X from candle times (not logical bar indexes).
	measurementTimeToX = (time) => {
		if (!this.chart) return null;

		const candles = this.plottedCandles;
		const numericTime = Number(time);

		if (!Array.isArray(candles) || !candles.length || !Number.isFinite(numericTime)) {
			return null;
		}

		const direct = this.chart.timeScale().timeToCoordinate(toChartTime(numericTime));
		if (Number.isFinite(direct)) return direct;

		const xAtCandle = (index) => this.measurementCandleScreenX(index);

		if (candles.length === 1) {
			return xAtCandle(0);
		}

		const firstTime = Number(candles[0].time);
		const lastIndex = candles.length - 1;
		const lastTime = Number(candles[lastIndex].time);

		if (numericTime <= firstTime) {
			const x0 = xAtCandle(0);
			const x1 = xAtCandle(1);
			if (!Number.isFinite(x0)) return null;
			if (!Number.isFinite(x1)) return x0;
			const step = Number(candles[1].time) - firstTime;
			if (!(step > 0)) return x0;
			return x0 + (x1 - x0) * ((numericTime - firstTime) / step);
		}

		if (numericTime >= lastTime) {
			const xPrev = xAtCandle(lastIndex - 1);
			const xLast = xAtCandle(lastIndex);
			if (!Number.isFinite(xLast)) return null;
			if (!Number.isFinite(xPrev)) return xLast;
			const step = lastTime - Number(candles[lastIndex - 1].time);
			if (!(step > 0)) return xLast;
			return xLast + (xLast - xPrev) * ((numericTime - lastTime) / step);
		}

		let low = 1;
		let high = lastIndex;

		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (Number(candles[middle].time) < numericTime) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}

		const upperIndex = low;
		const prevIndex = upperIndex - 1;
		const time0 = Number(candles[prevIndex].time);
		const time1 = Number(candles[upperIndex].time);
		const x0 = xAtCandle(prevIndex);
		const x1 = xAtCandle(upperIndex);

		if (!Number.isFinite(x0)) return null;
		if (!Number.isFinite(x1) || !(time1 > time0)) return x0;

		return x0 + (x1 - x0) * ((numericTime - time0) / (time1 - time0));
	};

	// Inverse of measurementTimeToX: screen X → time between neighboring candle pixels.
	measurementXToTime = (x) => {
		if (!this.chart || !Number.isFinite(x)) return null;

		const candles = this.plottedCandles;

		if (!Array.isArray(candles) || !candles.length) return null;

		const xAtCandle = (index) => this.measurementCandleScreenX(index);

		if (candles.length === 1) {
			return Number(candles[0].time);
		}

		const firstX = xAtCandle(0);
		const lastIndex = candles.length - 1;
		const lastX = xAtCandle(lastIndex);

		if (!Number.isFinite(firstX) || !Number.isFinite(lastX)) return null;

		if (x <= firstX) {
			const x1 = xAtCandle(1);
			const time0 = Number(candles[0].time);
			const time1 = Number(candles[1].time);
			if (!Number.isFinite(x1) || x1 === firstX) return time0;
			return time0 + (time1 - time0) * ((x - firstX) / (x1 - firstX));
		}

		if (x >= lastX) {
			const xPrev = xAtCandle(lastIndex - 1);
			const timePrev = Number(candles[lastIndex - 1].time);
			const timeLast = Number(candles[lastIndex].time);
			if (!Number.isFinite(xPrev) || xPrev === lastX) return timeLast;
			return timeLast + (timeLast - timePrev) * ((x - lastX) / (lastX - xPrev));
		}

		let low = 1;
		let high = lastIndex;

		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			const middleX = xAtCandle(middle);

			if (!Number.isFinite(middleX) || middleX < x) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}

		const upperIndex = low;
		const prevIndex = upperIndex - 1;
		const x0 = xAtCandle(prevIndex);
		const x1 = xAtCandle(upperIndex);
		const time0 = Number(candles[prevIndex].time);
		const time1 = Number(candles[upperIndex].time);

		if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 === x0) return time0;

		return time0 + (time1 - time0) * ((x - x0) / (x1 - x0));
	};

	getAutoscaleInfo = (original) => {
		const range = (
			this.state.isBullseyeViewActive
				? this.bullseyePriceRange
				: this.manualPriceRange
		);

		if (
			range
			&& Number.isFinite(range.min)
			&& Number.isFinite(range.max)
			&& range.max > range.min
		) {
			return {
				priceRange: {
					minValue: range.min,
					maxValue: range.max,
				},
			};
		}

		return original();
	};

	// VWAP/TD share the candle price scale. While a locked range drives
	// autoscale, contribute that same range so they can't widen the frame.
	// (Do not return priceRange: null — lightweight-charts rejects it.)
	getOverlayAutoscaleInfo = (original) => {
		const range = (
			this.state.isBullseyeViewActive
				? this.bullseyePriceRange
				: this.manualPriceRange
		);

		if (
			range
			&& Number.isFinite(range.min)
			&& Number.isFinite(range.max)
			&& range.max > range.min
		) {
			return {
				priceRange: {
					minValue: range.min,
					maxValue: range.max,
				},
			};
		}

		return original();
	};

	getPriceChange24h = (currentPrice) => {
		const { candles } = this.state;
		const price = Number(currentPrice);

		if (!Number.isFinite(price) || !candles.length) return null;

		const latestTime = candles[candles.length - 1].time;
		const targetTime = latestTime - 24 * 60 * 60;
		let reference = candles[0];

		candles.forEach(candle => {
			if (candle.time <= targetTime) {
				reference = candle;
			}
		});

		const referencePrice = Number(reference?.close);

		if (!Number.isFinite(referencePrice) || referencePrice === 0) return null;

		const value = price - referencePrice;

		return {
			value,
			percent: (value / referencePrice) * 100,
		};
	};

	getOverlayPriceChange24h = (currentPrice) => {
		const productStats = this.state.productStats;
		const productId = `${this.state.baseCurrency}-USD`.toUpperCase();
		const statsProductId = String(productStats?.product_id || "").toUpperCase();
		const statsOpen = Number(productStats?.open_24h);
		const price = Number(currentPrice);

		if (
			statsProductId === productId
			&& Number.isFinite(statsOpen)
			&& statsOpen !== 0
			&& Number.isFinite(price)
		) {
			const value = price - statsOpen;

			return {
				value,
				percent: (value / statsOpen) * 100,
			};
		}

		return this.getPriceChange24h(currentPrice);
	};

	getVolume24h = () => {
		const { candles } = this.state;

		if (!candles.length) return null;

		const latestTime = candles[candles.length - 1].time;
		const cutoffTime = latestTime - 24 * 60 * 60;
		const volume = candles.reduce((sum, candle) => {
			if (candle.time < cutoffTime) return sum;

			const candleVolume = Number(candle.volume);
			const close = Number(candle.close);

			return Number.isFinite(candleVolume) && Number.isFinite(close)
				? sum + candleVolume * close
				: sum;
		}, 0);

		return Number.isFinite(volume) ? volume : null;
	};

	getPriceLimits24h = (candles = this.state.candles) => {
		if (!Array.isArray(candles) || !candles.length) return null;

		const latestTime = Number(candles[candles.length - 1].time);
		if (!Number.isFinite(latestTime)) return null;

		const cutoffTime = latestTime - 24 * 60 * 60;
		let min = Infinity;
		let max = -Infinity;
		let fromTime = null;

		candles.forEach((candle) => {
			const time = Number(candle.time);
			if (!Number.isFinite(time) || time < cutoffTime) return;

			const high = Number(candle.high);
			const low = Number(candle.low);

			if (Number.isFinite(low)) min = Math.min(min, low);
			if (Number.isFinite(high)) max = Math.max(max, high);
			if (fromTime === null || time < fromTime) fromTime = time;
		});

		if (!Number.isFinite(min) || !Number.isFinite(max) || fromTime === null) return null;

		return {
			min,
			max,
			fromTime,
			toTime: latestTime,
		};
	};

	getCandleVolumeUsd = (candle) => {
		const volume = Number(candle?.volume);
		const high = Number(candle?.high);
		const low = Number(candle?.low);
		const close = Number(candle?.close);
		const typicalPrice = Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close)
			? (high + low + close) / 3
			: close;

		return Number.isFinite(volume) && Number.isFinite(typicalPrice)
			? Math.max(0, volume * typicalPrice)
			: 0;
	};

	getMeasurementAreaVolumeBreakdown = (start, end, candles = this.state.candles) => {
		const startTime = Number(start?.time);
		const endTime = Number(end?.time);

		if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
			return {
				upUsd: NaN,
				downUsd: NaN,
				totalUsd: NaN,
				deltaUsd: NaN,
				deltaPercent: NaN,
			};
		}

		const timeMin = Math.min(startTime, endTime);
		const timeMax = Math.max(startTime, endTime);
		let upUsd = 0;
		let downUsd = 0;

		(Array.isArray(candles) ? candles : []).forEach((candle) => {
			const candleTime = Number(candle?.time);

			if (!Number.isFinite(candleTime) || candleTime < timeMin || candleTime > timeMax) {
				return;
			}

			const usd = this.getCandleVolumeUsd(candle);
			if (!(usd > 0)) return;

			if (Number(candle?.close) >= Number(candle?.open)) {
				upUsd += usd;
			} else {
				downUsd += usd;
			}
		});

		const totalUsd = upUsd + downUsd;
		const deltaUsd = upUsd - downUsd;
		const deltaPercent = totalUsd > 0 ? (deltaUsd / totalUsd) * 100 : 0;

		return {
			upUsd,
			downUsd,
			totalUsd,
			deltaUsd,
			deltaPercent,
		};
	};

	getVolumeBarColor = (candle, isHighlighted = false) => {
		const isUp = Number(candle?.close) >= Number(candle?.open);

		if (isHighlighted) {
			return isUp
				? 'rgba(32, 178, 143, 0.92)'
				: 'rgba(238, 88, 88, 0.92)';
		}

		return isUp
			? 'rgba(32, 178, 143, 0.34)'
			: 'rgba(238, 88, 88, 0.34)';
	};

	buildVolumeData = (candles, highlightedIndex = this.state.hoveredVolumeIndex) => (
		candles.map((candle, index) => ({
			time: toChartTime(candle.time),
			value: this.getCandleVolumeUsd(candle),
			color: this.getVolumeBarColor(candle, index === highlightedIndex),
		}))
	);

	syncVolumeSeries = (candles = this.state.candles, highlightedIndex = this.state.hoveredVolumeIndex) => {
		if (!this.volumeSeries) return;

		this.volumeSeries.setData(this.buildVolumeData(candles, highlightedIndex));
	};

	computeEmaSeries = (values, period) => {
		const result = new Array(values.length).fill(null);

		if (!Array.isArray(values) || values.length < period || period <= 0) {
			return result;
		}

		let sum = 0;

		for (let index = 0; index < period; index += 1) {
			const value = Number(values[index]);

			if (!Number.isFinite(value)) return result;

			sum += value;
		}

		let ema = sum / period;
		result[period - 1] = ema;
		const multiplier = 2 / (period + 1);

		for (let index = period; index < values.length; index += 1) {
			const value = Number(values[index]);

			if (!Number.isFinite(value)) {
				result[index] = null;
				continue;
			}

			ema = ((value - ema) * multiplier) + ema;
			result[index] = ema;
		}

		return result;
	};

	buildMacdData = (candles = this.state.candles) => {
		if (!Array.isArray(candles) || !candles.length) return [];

		const closes = candles.map(candle => Number(candle.close));
		const fastEma = this.computeEmaSeries(closes, MACD_FAST_PERIOD);
		const slowEma = this.computeEmaSeries(closes, MACD_SLOW_PERIOD);
		const macdLine = closes.map((_, index) => {
			const fast = fastEma[index];
			const slow = slowEma[index];

			if (!Number.isFinite(fast) || !Number.isFinite(slow)) return null;

			return fast - slow;
		});
		const signalSeedValues = macdLine.map(value => (Number.isFinite(value) ? value : null));
		const firstMacdIndex = signalSeedValues.findIndex(value => value !== null);

		if (firstMacdIndex < 0) return [];

		const macdForSignal = signalSeedValues.slice(firstMacdIndex);
		const signalFromStart = this.computeEmaSeries(macdForSignal, MACD_SIGNAL_PERIOD);
		const signalLine = new Array(macdLine.length).fill(null);

		signalFromStart.forEach((value, index) => {
			signalLine[firstMacdIndex + index] = value;
		});

		return candles.map((candle, index) => {
			const macd = macdLine[index];
			const signal = signalLine[index];
			const time = Number(candle.time);

			if (!Number.isFinite(time) || !Number.isFinite(macd) || !Number.isFinite(signal)) {
				return null;
			}

			return {
				time,
				macd,
				signal,
				histogram: macd - signal,
			};
		}).filter(Boolean);
	};

	// TradingView PVT: cum(volume * change(close) / close[1])
	buildPvtSeriesData = (candles = this.state.candles) => {
		if (!Array.isArray(candles) || !candles.length) return [];

		const points = [];
		let pvt = 0;
		let prevClose = null;

		for (let index = 0; index < candles.length; index += 1) {
			const time = Number(candles[index].time);
			const volume = Number(candles[index].volume);
			const close = Number(candles[index].close);

			if (!Number.isFinite(time)) continue;

			const safeVolume = Number.isFinite(volume) ? Math.max(0, volume) : 0;

			if (
				Number.isFinite(close)
				&& Number.isFinite(prevClose)
				&& prevClose !== 0
			) {
				pvt += safeVolume * ((close - prevClose) / prevClose);
			}

			if (Number.isFinite(close)) prevClose = close;

			points.push({
				time,
				value: pvt,
			});
		}

		return points;
	};

	buildPvtPlotPath = (priceScaleLeft, bandBottom, bandHeight) => {
		const points = this.cachedPvtPoints;

		if (
			!this.chart
			|| !Array.isArray(points)
			|| !points.length
			|| !(bandHeight > 0)
		) {
			return "";
		}

		const timeScale = this.chart.timeScale();
		const visibleLogicalRange = timeScale.getVisibleLogicalRange?.();
		const candleCount = Array.isArray(this.state.candles) ? this.state.candles.length : 0;
		const from = visibleLogicalRange && Number.isFinite(visibleLogicalRange.from)
			? Math.max(0, Math.floor(visibleLogicalRange.from))
			: 0;
		const to = visibleLogicalRange && Number.isFinite(visibleLogicalRange.to)
			? Math.min(Math.max(candleCount - 1, 0), Math.ceil(visibleLogicalRange.to))
			: Math.max(candleCount - 1, 0);

		if (to < from || candleCount <= 0) return "";

		const pointByTime = new Map(points.map(point => [point.time, point]));
		const visibleCount = to - from + 1;
		// Prefer every bar; only bucket when far denser than screen pixels.
		const maxPoints = Math.max(2, Math.ceil(Math.max(priceScaleLeft, 1) * 2));
		const step = visibleCount <= maxPoints
			? 1
			: Math.max(1, Math.ceil(visibleCount / maxPoints));
		const sampled = [];

		const pushSample = (candleIndex) => {
			const candle = this.state.candles[candleIndex];
			const point = pointByTime.get(Number(candle?.time));
			const x = this.timeToX(candle?.time);

			if (!point || !Number.isFinite(x) || !Number.isFinite(point.value)) return;

			const previous = sampled[sampled.length - 1];

			if (previous && Math.abs(previous.x - x) < 0.25 && previous.value === point.value) {
				return;
			}

			sampled.push({ x, value: point.value, index: candleIndex });
		};

		if (step === 1) {
			for (let index = from; index <= to; index += 1) {
				pushSample(index);
			}
		} else {
			// Extrema-preserving buckets: first, min, max (time order), last.
			for (let bucketStart = from; bucketStart <= to; bucketStart += step) {
				const bucketEnd = Math.min(to, bucketStart + step - 1);
				let minIndex = bucketStart;
				let maxIndex = bucketStart;
				let minValue = Infinity;
				let maxValue = -Infinity;

				for (let index = bucketStart; index <= bucketEnd; index += 1) {
					const point = pointByTime.get(Number(this.state.candles[index]?.time));
					if (!point || !Number.isFinite(point.value)) continue;

					if (point.value < minValue) {
						minValue = point.value;
						minIndex = index;
					}

					if (point.value > maxValue) {
						maxValue = point.value;
						maxIndex = index;
					}
				}

				const ordered = [bucketStart];
				if (minIndex !== bucketStart && minIndex !== bucketEnd) ordered.push(minIndex);
				if (
					maxIndex !== bucketStart
					&& maxIndex !== bucketEnd
					&& maxIndex !== minIndex
				) {
					ordered.push(maxIndex);
				}
				if (bucketEnd !== bucketStart) ordered.push(bucketEnd);
				ordered.sort((left, right) => left - right);

				let lastPushed = null;
				ordered.forEach((index) => {
					if (index === lastPushed) return;
					lastPushed = index;
					pushSample(index);
				});
			}
		}

		if (sampled.length < 2) return "";

		// Scale from the true visible-window PVT range (all bars), not just samples.
		let minValue = Infinity;
		let maxValue = -Infinity;

		for (let index = from; index <= to; index += 1) {
			const point = pointByTime.get(Number(this.state.candles[index]?.time));
			if (!point || !Number.isFinite(point.value)) continue;
			minValue = Math.min(minValue, point.value);
			maxValue = Math.max(maxValue, point.value);
		}

		if (!(maxValue >= minValue) || !Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
			return "";
		}

		const span = maxValue - minValue;
		const coords = sampled.map(point => ({
			x: point.x,
			y: span > 0
				? bandBottom - ((point.value - minValue) / span) * bandHeight
				: bandBottom - bandHeight * 0.5,
		}));

		return this.buildSmoothOverlayPath(coords);
	};

	buildMacdPlotModel = (priceScaleLeft, zeroY, amplitude) => {
		const points = this.cachedMacdPoints;

		if (!this.chart || !Array.isArray(points) || !points.length || amplitude <= 0) {
			return null;
		}

		const timeScale = this.chart.timeScale();
		const visibleLogicalRange = timeScale.getVisibleLogicalRange?.();
		const candleCount = Array.isArray(this.state.candles) ? this.state.candles.length : 0;
		const from = visibleLogicalRange && Number.isFinite(visibleLogicalRange.from)
			? Math.max(0, Math.floor(visibleLogicalRange.from))
			: 0;
		const to = visibleLogicalRange && Number.isFinite(visibleLogicalRange.to)
			? Math.min(Math.max(candleCount - 1, 0), Math.ceil(visibleLogicalRange.to))
			: Math.max(candleCount - 1, 0);

		if (to < from || candleCount <= 0) return null;

		const pointByTime = new Map(points.map(point => [point.time, point]));
		const visibleCount = to - from + 1;
		const targetBuckets = Math.max(2, Math.ceil(Math.max(priceScaleLeft, 1)));
		const step = Math.max(1, Math.ceil(visibleCount / targetBuckets));
		const sampled = [];

		for (let index = from; index <= to; index += step) {
			const sampleIndex = Math.min(to, index + step - 1);
			const candle = this.state.candles[sampleIndex];
			const point = pointByTime.get(Number(candle?.time));
			// Time-based X stays stable when older bars prepend and logical indices shift.
			const x = this.timeToX(candle?.time);

			if (!point || !Number.isFinite(x)) continue;

			sampled.push({ x, ...point });
		}

		const lastCandle = this.state.candles[to];
		const lastPoint = pointByTime.get(Number(lastCandle?.time));
		const lastX = this.timeToX(lastCandle?.time);

		if (
			lastPoint
			&& Number.isFinite(lastX)
			&& (!sampled.length || sampled[sampled.length - 1].x < lastX - 0.5)
		) {
			sampled.push({ x: lastX, ...lastPoint });
		}

		const maxAbs = sampled.reduce((max, point) => Math.max(
			max,
			Math.abs(point.histogram),
			Math.abs(point.macd),
			Math.abs(point.signal),
		), 0);

		if (maxAbs <= 0) return null;

		const toY = (value) => zeroY - (value / maxAbs) * amplitude;
		const histogramCoords = sampled.map(point => ({
			x: point.x,
			value: point.histogram,
			y: toY(point.histogram),
		}));
		const macdCoords = sampled.map(point => ({
			x: point.x,
			y: toY(point.macd),
		}));
		const signalCoords = sampled.map(point => ({
			x: point.x,
			y: toY(point.signal),
		}));

		return {
			histogramCoords,
			macdPath: this.buildSmoothOverlayPath(macdCoords),
			signalPath: this.buildSmoothOverlayPath(signalCoords),
		};
	};

	buildVolumeOverlayCoords = (plotPoints, xForTime, yForValue) => {
		const buckets = [];

		plotPoints.forEach((point) => {
			const x = xForTime(point.time);
			const value = Number(point.value);

			if (!Number.isFinite(x) || !Number.isFinite(value)) return;

			const previous = buckets[buckets.length - 1];

			if (previous && x <= previous.x + 0.5) {
				// Keep the latest sample in this pixel — averaging signed volume
				// cancels toward zero on zoom-out and makes the overlay vanish.
				previous.x = x;
				previous.value = value;
				return;
			}

			buckets.push({ x, value });
		});

		return buckets
			.map((bucket) => ({
				x: bucket.x,
				y: yForValue(bucket.value),
				value: bucket.value,
			}))
			.filter(point => Number.isFinite(point.y));
	};

	buildSmoothOverlayPath = (coords) => {
		if (!coords.length) return "";

		if (coords.length === 1) {
			return `M ${coords[0].x.toFixed(2)} ${coords[0].y.toFixed(2)}`;
		}

		return coords.map((point, index) => (
			`${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
		)).join(" ");
	};

	buildVolumeOverlayAreaPathFromCoords = (coords, baselineY) => {
		if (!coords.length) return "";

		const linePath = this.buildSmoothOverlayPath(coords);
		const firstX = coords[0].x;
		const lastX = coords[coords.length - 1].x;

		return `${linePath} L ${lastX.toFixed(2)} ${baselineY.toFixed(2)} L ${firstX.toFixed(2)} ${baselineY.toFixed(2)} Z`;
	};

	buildSignedVolumeOverlayAreaPaths = (coords, zeroY) => {
		const positivePaths = [];
		const negativePaths = [];

		if (coords.length < 2) {
			return { positivePaths, negativePaths };
		}

		const signOf = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);
		const pushSegment = (segment, sign) => {
			if (segment.length < 2 || !sign) return;

			const path = this.buildVolumeOverlayAreaPathFromCoords(segment, zeroY);

			if (!path) return;

			if (sign > 0) positivePaths.push(path);
			else negativePaths.push(path);
		};

		let segment = [{ x: coords[0].x, y: coords[0].y }];
		let segmentSign = signOf(coords[0].value);

		for (let index = 1; index < coords.length; index += 1) {
			const previous = coords[index - 1];
			const current = coords[index];
			const previousSign = signOf(previous.value);
			const currentSign = signOf(current.value);

			if (previousSign && currentSign && previousSign !== currentSign) {
				const span = current.value - previous.value;
				const ratio = Math.abs(span) > 0 ? (-previous.value / span) : 0.5;
				const crossX = previous.x + (current.x - previous.x) * ratio;
				const crossPoint = { x: crossX, y: zeroY };

				segment.push(crossPoint);
				pushSegment(segment, segmentSign || previousSign);
				segment = [crossPoint, { x: current.x, y: current.y }];
				segmentSign = currentSign;
				continue;
			}

			if (!segmentSign && currentSign) {
				segmentSign = currentSign;
			}

			if (segmentSign && currentSign && currentSign !== segmentSign) {
				pushSegment(segment, segmentSign);
				segment = [{ x: previous.x, y: zeroY }, { x: current.x, y: current.y }];
				segmentSign = currentSign;
				continue;
			}

			segment.push({ x: current.x, y: current.y });
		}

		pushSegment(segment, segmentSign);

		return { positivePaths, negativePaths };
	};

	getVwapSeriesOptions = () => ({
		color: '#28d7d7',
		lineWidth: 2,
		lineType: LineType.Curved,
		visible: this.state.showVwapIndicator,
		priceLineVisible: false,
		lastValueVisible: false,
		crosshairMarkerVisible: false,
		priceFormat: this.getPriceSeriesFormat(),
		autoscaleInfoProvider: this.getOverlayAutoscaleInfo,
	});

	buildVwapSessions = (candles) => {
		let cumulativePriceVolume = 0;
		let cumulativeVolume = 0;
		let sessionKey = null;
		const sessions = [];
		let currentSession = null;

		candles.forEach(candle => {
			const high = Number(candle.high);
			const low = Number(candle.low);
			const close = Number(candle.close);
			const volume = Number(candle.volume);
			const candleSessionKey = getVwapSessionKey(candle.time);

			if (candleSessionKey !== sessionKey) {
				sessionKey = candleSessionKey;
				cumulativePriceVolume = 0;
				cumulativeVolume = 0;
				currentSession = {
					key: sessionKey,
					data: [],
				};
				sessions.push(currentSession);
			}

			if (
				Number.isFinite(high)
				&& Number.isFinite(low)
				&& Number.isFinite(close)
				&& Number.isFinite(volume)
				&& volume > 0
			) {
				const typicalPrice = (high + low + close) / 3;
				cumulativePriceVolume += typicalPrice * volume;
				cumulativeVolume += volume;
			}

			const value = cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : close;

			if (Number.isFinite(value) && currentSession) {
				currentSession.data.push({
					time: candle.time,
					value,
				});
			}
		});

		return sessions.filter(session => session.data.length);
	};

	syncVwapSeries = (candles) => {
		if (!this.chart) return;

		const sessions = this.buildVwapSessions(candles);

		while (this.vwapSeries.length < sessions.length) {
			this.vwapSeries.push(this.chart.addSeries(
				LineSeries,
				this.getVwapSeriesOptions()
			));
		}

		while (this.vwapSeries.length > sessions.length) {
			const series = this.vwapSeries.pop();
			this.chart.removeSeries(series);
		}

		sessions.forEach((session, index) => {
			this.vwapSeries[index].applyOptions({
				visible: this.state.showVwapIndicator,
				autoscaleInfoProvider: this.getOverlayAutoscaleInfo,
			});
			this.vwapSeries[index].setData(toChartData(session.data));
		});

		const currentCandle = candles[candles.length - 1];
		if (!currentCandle || !sessions.length) {
			this.liveVwapContext = null;
			return;
		}

		const sessionKey = getVwapSessionKey(currentCandle.time);
		let cumulativePriceVolume = 0;
		let cumulativeVolume = 0;

		for (let index = candles.length - 2; index >= 0; index -= 1) {
			const candle = candles[index];
			if (getVwapSessionKey(candle.time) !== sessionKey) break;

			const high = Number(candle.high);
			const low = Number(candle.low);
			const close = Number(candle.close);
			const volume = Number(candle.volume);

			if (
				Number.isFinite(high)
				&& Number.isFinite(low)
				&& Number.isFinite(close)
				&& Number.isFinite(volume)
				&& volume > 0
			) {
				cumulativePriceVolume += ((high + low + close) / 3) * volume;
				cumulativeVolume += volume;
			}
		}

		this.liveVwapContext = {
			cumulativePriceVolume,
			cumulativeVolume,
			seriesIndex: sessions.length - 1,
			sessionKey,
		};
	};

	updateCurrentVwapPoint = (currentCandle) => {
		const context = this.liveVwapContext;
		if (
			!currentCandle
			|| !context
			|| getVwapSessionKey(currentCandle.time) !== context.sessionKey
		) {
			return;
		}

		const series = this.vwapSeries[context.seriesIndex];
		if (!series) return;

		const high = Number(currentCandle.high);
		const low = Number(currentCandle.low);
		const close = Number(currentCandle.close);
		const volume = Number(currentCandle.volume);
		let cumulativePriceVolume = context.cumulativePriceVolume;
		let cumulativeVolume = context.cumulativeVolume;

		if (
			Number.isFinite(high)
			&& Number.isFinite(low)
			&& Number.isFinite(close)
			&& Number.isFinite(volume)
			&& volume > 0
		) {
			cumulativePriceVolume += ((high + low + close) / 3) * volume;
			cumulativeVolume += volume;
		}

		const value = cumulativeVolume > 0
			? cumulativePriceVolume / cumulativeVolume
			: close;

		if (!Number.isFinite(value)) return;

		series.update(toChartPoint({
			time: currentCandle.time,
			value,
		}));
	};

	getLoadedTimeRange = (candles = this.state.candles) => {
		if (!Array.isArray(candles) || !candles.length) return null;

		const from = Number(candles[0].time);
		const latestCandleTime = Number(candles[candles.length - 1].time);
		const to = Math.max(latestCandleTime, Math.floor(Date.now() / 1000));

		if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

		return { from, to };
	};

	isTimeInLoadedRange = (time, candles = this.state.candles) => {
		const range = this.getLoadedTimeRange(candles);
		const normalizedTime = Number(time);

		if (!range) return Number.isFinite(normalizedTime);
		return Number.isFinite(normalizedTime)
			&& normalizedTime >= range.from
			&& normalizedTime <= range.to;
	};

	getChartCandleAtOrBeforeTime = (time, candles = this.state.candles) => {
		const normalizedTime = Number(time);

		if (!Array.isArray(candles) || !candles.length || !Number.isFinite(normalizedTime)) {
			return null;
		}

		let low = 0;
		let high = candles.length - 1;
		let best = null;

		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const candleTime = Number(candles[middle].time);

			if (!Number.isFinite(candleTime)) {
				break;
			}

			if (candleTime <= normalizedTime) {
				best = candles[middle];
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}

		return best || candles[0];
	};

	syncTdSequentialSeries = (tdSequential = this.state.tdSequential, candles = this.state.candles) => {
		if (!this.tdSequentialSeries) return;

		this.tdSequentialSeries.applyOptions({ visible: this.state.showTdIndicator });
		const candleTimes = new Set(
			(Array.isArray(candles) ? candles : [])
				.map(candle => Number(candle.time))
				.filter(Number.isFinite),
		);

		const data = (Array.isArray(tdSequential?.candles) ? tdSequential.candles : [])
			.map(candle => ({
				time: Number(candle.time),
				value: Number(candle.close),
			}))
			.filter(point => Number.isFinite(point.time) && Number.isFinite(point.value))
			.filter(point => (
				this.isTimeInLoadedRange(point.time, candles)
				&& candleTimes.has(point.time)
			));

		this.tdSequentialSeries.setData(toChartData(data));
		this.syncBullseyeViewIfActive();
	};

	getMacdOverlayModel = () => {
		const { candles, chartSize, overlayTick, showMacdIndicator, showPvtIndicator } = this.state;

		if (
			(!showMacdIndicator && !showPvtIndicator)
			|| !candles.length
			|| !chartSize.width
			|| !chartSize.height
		) {
			this.cachedMacdOverlayModel = null;
			this.cachedMacdOverlayKey = null;
			return null;
		}

		// MACD/PVT sit in the volume pane — independent of main Y price scale.
		// Reuse cache on priceOverlayTick-only updates (Y-wheel).
		const cacheKey = [
			overlayTick,
			chartSize.width,
			chartSize.height,
			showMacdIndicator,
			showPvtIndicator,
			candles.length,
			this.cachedMacdPoints?.length || 0,
			this.cachedPvtPoints?.length || 0,
		].join("|");

		if (this.cachedMacdOverlayKey === cacheKey) {
			return this.cachedMacdOverlayModel;
		}

		const seriesPaneHeight = chartSize.height - CHART_TIME_SCALE_HEIGHT;
		const volumePaneBottom = (() => {
			const y = this.volumeSeries?.priceToCoordinate?.(0);

			return Number.isFinite(y) ? y : seriesPaneHeight;
		})();
		const volumePaneTop = seriesPaneHeight * 0.82;
		const volumePaneHeight = Math.max(0, volumePaneBottom - volumePaneTop);
		const priceScaleWidth = Math.max(this.chart?.priceScale("right")?.width?.() || 0, 76);
		const priceScaleLeft = Math.max(120, chartSize.width - priceScaleWidth);
		const macdZeroY = volumePaneTop + volumePaneHeight / 2;
		const macdAmplitude = Math.max(volumePaneHeight * 0.5 - 2, volumePaneHeight * 0.45);
		// Vertical squash was 0.4; 0.8 = 2x taller while still centered on the volume pane.
		const macdScaleY = 0.8;
		const macdOffsetY = -40;

		let positivePaths = [];
		let negativePaths = [];
		let macdPath = null;
		let signalPath = null;

		if (showMacdIndicator) {
			const plotModel = this.buildMacdPlotModel(
				priceScaleLeft,
				macdZeroY,
				macdAmplitude,
			);

			if (plotModel) {
				({ positivePaths, negativePaths } = this.buildSignedVolumeOverlayAreaPaths(
					plotModel.histogramCoords,
					macdZeroY,
				));
				macdPath = plotModel.macdPath;
				signalPath = plotModel.signalPath;
			}
		}

		// PVT sits in a band just above the MACD amplitude.
		let pvtPath = null;
		if (showPvtIndicator) {
			const pvtBandHeight = Math.max(20, volumePaneHeight * 0.336);
			const pvtBandBottom = macdZeroY - macdAmplitude - 8;
			pvtPath = this.buildPvtPlotPath(
				priceScaleLeft,
				pvtBandBottom,
				pvtBandHeight,
			);
		}

		// Return null only when nothing will render.
		if (
			(!positivePaths.length && !negativePaths.length && !macdPath && !signalPath)
			&& !pvtPath
		) {
			this.cachedMacdOverlayModel = null;
			this.cachedMacdOverlayKey = cacheKey;
			return null;
		}

		const model = {
			width: priceScaleLeft,
			height: chartSize.height,
			transform: `translate(0 ${macdOffsetY}) translate(0 ${volumePaneTop}) scale(1 ${macdScaleY}) translate(0 ${-volumePaneTop})`,
			positivePaths,
			negativePaths,
			macdPath,
			signalPath,
			pvtPath,
			zeroY: macdZeroY,
		};

		this.cachedMacdOverlayModel = model;
		this.cachedMacdOverlayKey = cacheKey;
		return model;
	};

	renderMacdOverlay = () => {
		const model = this.getMacdOverlayModel();

		if (!model) return null;

		return (
			<svg
				className="e__macd-overlay"
				width={model.width}
				height={model.height}
				style={{ width: model.width }}
			>
				<g
					className="e__macd-overlay__plot"
					transform={model.transform}
				>
					{model.pvtPath && (
						<path
							className="e__macd-overlay__pvt-line"
							d={model.pvtPath}
							fill="none"
							stroke="rgba(120, 190, 255, 0.9)"
							strokeWidth="1.62"
						/>
					)}
					{model.positivePaths.map((path, index) => (
						<path
							key={`macd-pos-${index}`}
							d={path}
							fill="rgba(32, 178, 143, 0.45)"
						/>
					))}
					{model.negativePaths.map((path, index) => (
						<path
							key={`macd-neg-${index}`}
							d={path}
							fill="rgba(238, 88, 88, 0.45)"
						/>
					))}
					{model.macdPath && (
						<path
							className="e__macd-overlay__macd-line"
							d={model.macdPath}
							fill="none"
							stroke="rgba(242, 246, 248, 0.88)"
							strokeWidth="1.25"
						/>
					)}
					{model.signalPath && (
						<path
							className="e__macd-overlay__signal-line"
							d={model.signalPath}
							fill="none"
							stroke="rgba(255, 176, 32, 0.9)"
							strokeWidth="1.25"
						/>
					)}
				</g>
			</svg>
		);
	};

	renderOverlay = () => {
		this.overlayReferenceLabels = [];

		const {
			candles,
			depth,
			allOrders,
			tdSequential,
			chartSize,
			freeCrosshairX,
			pointerPosition,
			hoveredVolumeIndex,
			measurementStart,
			measurementEnd,
			orderTicket,
			overlayTick,
			priceOverlayTick,
			showDepthIndicator,
			showTdIndicator,
			showVolhIndicator,
			showPrchIndicator,
			showLims24Indicator,
			showBagValueIndicator,
		} = this.state;

		const orders = this.getChartOrders(allOrders);

		void overlayTick;
		void priceOverlayTick;

		if (!candles.length || !chartSize.width || !chartSize.height) {
			return null;
		}

		const distribution = (showVolhIndicator || showPrchIndicator)
			? this.getCachedDistribution()
			: { bins: [], maxValue: 0, maxCountValue: 0 };
		const currentPrice = Number(candles[candles.length - 1].close);
		const currentY = this.priceToY(currentPrice);
		const bagUsdNotional = showBagValueIndicator
			? this.getSelectedCoinBagUsdNotional()
			: null;
		const mappedCurrentX = this.timeToX(candles[candles.length - 1].time);
		if (Number.isFinite(mappedCurrentX)) {
			this.lastDepthStartX = mappedCurrentX;
		}
		const currentX = Number.isFinite(mappedCurrentX)
			? mappedCurrentX
			: (Number.isFinite(this.lastDepthStartX) ? this.lastDepthStartX : null);
		const bids = Array.isArray(depth?.bids) ? depth.bids : [];
		const asks = Array.isArray(depth?.asks) ? depth.asks : [];
		const profileLeft = 12;
		const priceScaleWidth = Math.max(this.chart?.priceScale("right")?.width?.() || 0, 76);
		const priceScaleLeft = Math.max(120, chartSize.width - priceScaleWidth);
		const bagUsdLabel = (
			Number.isFinite(bagUsdNotional)
			&& bagUsdNotional > 0
			&& currentY !== null
		)
			? Math.round(bagUsdNotional).toLocaleString(undefined, {
				style: "currency",
				currency: "USD",
				minimumFractionDigits: 0,
				maximumFractionDigits: 0,
			})
			: null;
		const bagUsdLabelLayout = bagUsdLabel
			? this.getOverlayLabelLayout(bagUsdLabel, priceScaleLeft)
			: null;
		const maxProfileWidth = Math.min(178, chartSize.width * 0.18);
		const buildDistributionPoints = (valueKey, maxValue) => (
			distribution.bins.map(bin => {
				const y = this.priceToY(bin.price);

				if (y === null || maxValue <= 0) return null;

				return {
					price: bin.price,
					x: profileLeft + (bin[valueKey] / maxValue) * maxProfileWidth,
					y,
				};
			}).filter(Boolean)
		);
		const buildPolyline = (points) => points
			.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
			.join(" ");
		const distributionPoints = showVolhIndicator
			? buildDistributionPoints("volumeValue", distribution.maxValue)
			: [];
		const countDistributionPoints = showPrchIndicator
			? buildDistributionPoints("countValue", distribution.maxCountValue)
			: [];
		const distributionLine = showVolhIndicator ? buildPolyline(distributionPoints) : "";
		const countDistributionLine = showPrchIndicator
			? buildPolyline(countDistributionPoints)
			: "";
		const depthStartX = currentX ?? Math.max(80, chartSize.width - 150);
		const depthRightLimit = Math.max(depthStartX + 24, chartSize.width - 76);
		const availableDepthWidth = Math.max(24, depthRightLimit - depthStartX);
		const targetDepthWidth = Math.min(
			availableDepthWidth,
			Math.max(chartSize.width * MIN_DEPTH_WIDTH_RATIO, availableDepthWidth),
		);
		const getLevelUsdValue = (level) => {
			const price = Number(level.price);
			const size = Number(level.size);

			return Number.isFinite(price) && Number.isFinite(size)
				? Math.max(0, price * size)
				: 0;
		};
		const maxCumulativeDepth = Math.max(
			bids.reduce((sum, level) => sum + getLevelUsdValue(level), 0),
			asks.reduce((sum, level) => sum + getLevelUsdValue(level), 0),
			1
		);
		const depthPixelsPerUsd = targetDepthWidth / maxCumulativeDepth;

		const buildDepthPoints = (levels, direction) => {
			const sorted = [...levels].sort((a, b) => direction * (Number(a.price) - Number(b.price)));
			let cumulative = 0;

			const points = currentY === null
				? []
				: [{ x: depthStartX, y: currentY, price: currentPrice, cumulative: 0 }];

			sorted.forEach(level => {
				const price = Number(level.price);
				const y = this.priceToY(price);

				if (
					y === null
					|| !Number.isFinite(price)
					|| (direction > 0 && price < currentPrice)
					|| (direction < 0 && price > currentPrice)
				) {
					return;
				}

				cumulative += getLevelUsdValue(level);
				points.push({
					x: Math.min(depthRightLimit, depthStartX + cumulative * depthPixelsPerUsd),
					y,
					price,
					cumulative,
				});
			});

			return points;
		};
		const askPoints = buildDepthPoints(asks, 1);
		const bidPoints = buildDepthPoints(bids, -1);
		const buildStepLine = (points) => {
			if (!points.length) return "";

			const stepPoints = [points[0]];

			for (let index = 1; index < points.length; index++) {
				const previous = stepPoints[stepPoints.length - 1];
				const point = points[index];

				stepPoints.push({ ...previous, y: point.y });
				stepPoints.push(point);
			}

			return stepPoints
				.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
				.join(" ");
		};
		const askLine = buildStepLine(askPoints);
		const bidLine = buildStepLine(bidPoints);
		const askTrail = askPoints.length > 1 ? askPoints[askPoints.length - 1] : null;
		const bidTrail = bidPoints.length > 1 ? bidPoints[bidPoints.length - 1] : null;
		const getTrailLabelPosition = (point, yOffset) => {
			const nearRightEdge = point.x > chartSize.width - 96;

			return {
				x: nearRightEdge ? point.x - 8 : point.x + 8,
				y: Math.min(chartSize.height - 10, Math.max(12, point.y + yOffset)),
				anchor: nearRightEdge ? "end" : "start",
			};
		};
		const askTrailLabel = askTrail ? getTrailLabelPosition(askTrail, -8) : null;
		const bidTrailLabel = bidTrail ? getTrailLabelPosition(bidTrail, 14) : null;
		const findDepthHoverPoint = () => {
			if (!pointerPosition) return null;

			const candidates = [
				...askPoints.slice(1).map(point => ({ ...point, side: "ask" })),
				...bidPoints.slice(1).map(point => ({ ...point, side: "bid" })),
			];

			if (!candidates.length) return null;

			const nearest = candidates.reduce((best, point) => {
				const distance = Math.hypot(point.x - pointerPosition.x, point.y - pointerPosition.y);

				return distance < best.distance
					? { point, distance }
					: best;
			}, { point: null, distance: Infinity });

			return nearest.distance <= 28 ? nearest.point : null;
		};
		const depthHoverPoint = findDepthHoverPoint();
		const depthHoverLabel = depthHoverPoint
			? {
				x: depthHoverPoint.x - 8,
				y: Math.min(
					chartSize.height - 10,
					Math.max(12, depthHoverPoint.y + (depthHoverPoint.side === "ask" ? -14 : 18)),
				),
				anchor: "end",
			}
			: null;
		const orderLineRight = priceScaleLeft;
		const drag = this.state.openOrderDrag;
		let drawableOrders = uniqueOrdersByOriginalId(
			(Array.isArray(orders) ? orders : []).filter(order => isDisplayableOrderStatus(order.status)),
		)
			.flatMap(order => (
				Array.isArray(order.bracket_legs) && order.bracket_legs.length
					? order.bracket_legs.map(leg => ({
						...order,
						...leg,
						order_type: order.order_type,
						// Leg confirmed $ only — never parent BUY / parent order_total.
						original_value_usd: undefined,
						used_value_usd: undefined,
						used_percent: undefined,
						remaining_value_usd: undefined,
						used_before_current_order_usd: undefined,
						quote_size: undefined,
						order_total: leg.order_total,
						total_value: leg.total_value,
					}))
					: [order]
			));

		const orderLines = drawableOrders
			.map(order => {
				const orderType = String(order.order_type || "").toUpperCase();
				const price = this.getLiveDragLinePrice(order, drag);
				const y = this.priceToY(price);
				const rolePrefix = order.role === "take_profit"
					? "TP "
					: order.role === "stop_loss"
						? "SL "
						: this.isTrailingOrderType(orderType)
							? `TRAIL ${Number(order.trail_percent).toFixed(2)}% `
							: "";

				if (y === null || !Number.isFinite(price) || price <= 0) return null;

				const isDraggedOrder = this.orderIsActiveDragTarget(order, drag);

				// While dragging: BUY limit keeps confirmed $; SELL/TP/SL = size × price.
				let valueLabel;
				if (isDraggedOrder) {
					const role = String(order.role || "").toLowerCase();
					const dragKind = String(drag.kind || "limit").toLowerCase();
					const dragSide = String(drag.side || order.side || "").toUpperCase();
					const isBuyLimitDrag = dragKind === "limit" && dragSide === "BUY" && !role;

					if (isBuyLimitDrag) {
						const buyNotional = this.getDragDisplayNotionalUsd(drag, order);
						valueLabel = buyNotional != null
							? formatOrderDisplayTotal({
								order_total: buyNotional,
								total_value: buyNotional,
								original_value_usd: buyNotional,
							})
							: "--";
					} else {
						const liveSize = Number(
							drag.size ?? order.amount ?? order.base_size
						);
						const liveNotional = this.getLiveDragNotionalUsd(liveSize, price);
						valueLabel = liveNotional != null
							? formatOrderDisplayTotal({
								role: order.role,
								amount: liveSize,
								price: price,
								order_total: liveNotional,
								total_value: liveNotional,
							})
							: "--";
					}
				} else {
					valueLabel = formatOrderDisplayTotal({
						...order,
						price,
						...(order.role
							? {
								original_value_usd: undefined,
								quote_size: undefined,
								order_total: order.order_total,
								total_value: order.total_value,
								amount: order.amount ?? order.base_size,
							}
							: {}),
					});
				}

				return {
					...order,
					orderType,
					price,
					y,
					label: `${rolePrefix}${this.formatOverlayPriceForProduct(price)} / ${valueLabel}`,
				};
			})
			.filter(Boolean);
		const orderLinesByOriginalId = new Map();
		orderLines.forEach(line => {
			const identity = String(line.original_id || "");
			if (!identity) return;
			orderLinesByOriginalId.set(`${identity}:${line.role || "limit"}`, line);
		});
		const uniqueOrderLines = Array.from(orderLinesByOriginalId.values());
		this.logChartOrderDisplayIfChanged(uniqueOrderLines);
		const bookmarkedPriceValue = this.getBookmarkedPriceForCurrency(
			this.state.baseCurrency
		);
		const bookmarkedCoordinate = bookmarkedPriceValue === null
			? null
			: this.priceToY(bookmarkedPriceValue);
		// Match open orders: keep drawing when off-pane (SVG clips at top/bottom).
		const bookmarkedY = Number.isFinite(bookmarkedCoordinate)
			? bookmarkedCoordinate
			: null;
		const bookmarkedLineRight = priceScaleLeft;
		const bookmarkedPriceLabel = bookmarkedY === null
			? ""
			: this.getReferenceLinePriceLabel(bookmarkedPriceValue);
		const bookmarkedDeltaLabel = bookmarkedY === null
			? null
			: this.getReferenceLineDeltaLabel(bookmarkedPriceValue);
		const bookmarkedPriceLabelLayout = bookmarkedY === null
			? null
			: this.getOverlayLabelLayout(bookmarkedPriceLabel, bookmarkedLineRight);
		const avgEntryPriceValue = Number(
			this.getAvgEntryPriceForDisplay(this.state.baseCurrency),
		);
		const avgEntryCoordinate = (
			Number.isFinite(avgEntryPriceValue) && avgEntryPriceValue > 0
				? this.priceToY(avgEntryPriceValue)
				: null
		);
		// Match open orders: keep drawing when off-pane (SVG clips at top/bottom).
		const avgEntryY = Number.isFinite(avgEntryCoordinate)
			? avgEntryCoordinate
			: null;
		const avgEntryLineRight = priceScaleLeft;
		const avgEntryPriceLabel = avgEntryY === null
			? ""
			: this.getReferenceLinePriceLabel(avgEntryPriceValue, { prefix: "AVG" });
		const avgEntryDeltaLabel = avgEntryY === null
			? null
			: this.getReferenceLineDeltaLabel(avgEntryPriceValue);
		const avgEntryPriceLabelLayout = avgEntryY === null
			? null
			: this.getOverlayLabelLayout(avgEntryPriceLabel, avgEntryLineRight);
		const overlayLabelCandidates = [
			...uniqueOrderLines.map(order => ({
				id: `order:${order.original_id}:${order.role || "limit"}`,
				y: order.y,
			})),
			...(bookmarkedY !== null
				? [{ id: "bookmark", y: bookmarkedY }]
				: []),
			...(avgEntryY !== null
				? [{ id: "avg-entry", y: avgEntryY }]
				: []),
		];
		const overlayLabelYById = new Map(
			[...overlayLabelCandidates]
				.sort((a, b) => a.y - b.y)
				.reduce((rows, item) => {
					const minGap = 16;
					const preferredY = Math.max(12, item.y - 5);
					const previousY = rows[rows.length - 1]?.labelY ?? -Infinity;

					rows.push({
						id: item.id,
						labelY: Math.min(
							chartSize.height - 8,
							Math.max(preferredY, previousY + minGap)
						),
					});

					return rows;
				}, [])
				.map(row => [row.id, row.labelY])
		);
		const bookmarkedLabelY = bookmarkedY === null
			? null
			: (overlayLabelYById.get("bookmark") ?? Math.min(
				chartSize.height - 8,
				Math.max(12, bookmarkedY - 5)
			));
		const avgEntryLabelY = avgEntryY === null
			? null
			: (overlayLabelYById.get("avg-entry") ?? Math.min(
				chartSize.height - 8,
				Math.max(12, avgEntryY - 5)
			));

		if (bookmarkedLabelY !== null && bookmarkedDeltaLabel) {
			this.overlayReferenceLabels.push({
				id: "bookmark",
				y: bookmarkedLabelY,
				label: bookmarkedDeltaLabel,
				tone: "bookmark",
			});
		}

		if (avgEntryLabelY !== null && avgEntryDeltaLabel) {
			this.overlayReferenceLabels.push({
				id: "avg-entry",
				y: avgEntryLabelY,
				label: avgEntryDeltaLabel,
				tone: "avg",
			});
		}

		const orderTicketSide = orderTicket?.side === "SELL" ? "SELL" : "BUY";
		const orderTicketType = orderTicket
			? this.normalizeOrderTypeForSide(orderTicketSide, orderTicket.orderType)
			: null;
		const isLimitOrderTicketMarker = orderTicketType === "LIMIT";
		const isSellBracketTicketMarker = orderTicketType === "BRACKET" && orderTicketSide === "SELL";
		const isSellTrailingTicketMarker = this.isTrailingOrderType(orderTicketType) && orderTicketSide === "SELL";
		const orderTicketPriceValue = Number(orderTicket?.price);
		const orderTicketY = (
			orderTicket
			&& isLimitOrderTicketMarker
			&& Number.isFinite(orderTicketPriceValue)
		)
			? this.priceToY(orderTicketPriceValue)
			: null;
		const orderTicketLineRight = priceScaleLeft;
		const orderTicketScaleLabelWidth = Math.max(62, Math.min(96, priceScaleWidth - 8));
		const orderTicketScaleLabelHeight = 20;
		const orderTicketScaleLabelX = priceScaleLeft + Math.max(4, (priceScaleWidth - orderTicketScaleLabelWidth) / 2);
		const orderTicketScaleLabelY = orderTicketY === null
			? null
			: Math.min(
				chartSize.height - orderTicketScaleLabelHeight - 2,
				Math.max(2, orderTicketY - orderTicketScaleLabelHeight / 2)
			);
		const orderTicketBracketMarkers = isSellBracketTicketMarker
			? [
				{
					id: "take-profit",
					role: "take-profit",
					price: Number(orderTicket.takeProfitPrice),
				},
				{
					id: "stop-loss",
					role: "stop-loss",
					price: Number(orderTicket.stopLossPrice),
				},
			]
				.filter(marker => Number.isFinite(marker.price) && marker.price > 0)
				.map(marker => ({
					...marker,
					y: this.priceToY(marker.price),
				}))
				.filter(marker => Number.isFinite(marker.y))
			: [];
		const trailingReferencePrice = Number(this.getOverlayMarketPrice());
		const trailingDraftPercent = Number(orderTicket?.trailPercent);
		const trailingDraftStopPrice = (
			isSellTrailingTicketMarker
			&& Number.isFinite(trailingReferencePrice)
			&& trailingReferencePrice > 0
			&& Number.isFinite(trailingDraftPercent)
			&& trailingDraftPercent > 0
			&& trailingDraftPercent < 100
		)
			? trailingReferencePrice * (1 - trailingDraftPercent / 100)
			: null;
		const orderTicketTrailingY = Number.isFinite(trailingDraftStopPrice) && trailingDraftStopPrice > 0
			? this.priceToY(trailingDraftStopPrice)
			: null;
		const tdSequentialBadges = (showTdIndicator && Array.isArray(tdSequential?.setups) ? tdSequential.setups : [])
			.filter(setup => this.isTimeInLoadedRange(setup.time, candles))
			.map(setup => {
				const side = setup.side === "sell" ? "sell" : "buy";
				const time = Number(setup.time);
				const count = Number(setup.count);
				const complete = Boolean(setup.complete) || count === 9;
				const anchorCandle = this.getChartCandleAtOrBeforeTime(time, candles);
				const anchorTime = Number(anchorCandle?.time ?? time);
				const x = this.timeToX(anchorTime);
				const highY = this.priceToY(Number(anchorCandle?.high ?? setup.price));
				const lowY = this.priceToY(Number(anchorCandle?.low ?? setup.price));
				const triangleWidth = 14;
				const triangleHeight = 12;
				const gap = 8;
				const labelGap = 14;

				if (
					!Number.isFinite(x)
					|| !Number.isFinite(highY)
					|| !Number.isFinite(lowY)
					|| !Number.isFinite(count)
				) {
					return null;
				}

				if (x < -40 || x > chartSize.width + 40) return null;

				const candleTop = Math.min(highY, lowY);
				const candleBottom = Math.max(highY, lowY);
				const halfH = triangleHeight / 2;
				const halfW = triangleWidth / 2;
				const y = side === "buy"
					? candleBottom + gap + halfH
					: candleTop - gap - halfH;
				const points = side === "buy"
					? `${x},${(y - halfH).toFixed(1)} ${(x - halfW).toFixed(1)},${(y + halfH).toFixed(1)} ${(x + halfW).toFixed(1)},${(y + halfH).toFixed(1)}`
					: `${(x - halfW).toFixed(1)},${(y - halfH).toFixed(1)} ${(x + halfW).toFixed(1)},${(y - halfH).toFixed(1)} ${x},${(y + halfH).toFixed(1)}`;
				const textY = side === "buy"
					? y + halfH + labelGap
					: y - halfH - 3;

				return {
					...setup,
					x,
					y,
					textY,
					points,
					text: String(count),
					side,
					complete,
				};
			})
			.filter(Boolean);
		const measurementPreview = measurementStart && !measurementEnd && pointerPosition
			? this.getMeasurementPointFromCoordinates(pointerPosition.x, pointerPosition.y)
			: null;
		const measurementTarget = measurementEnd || measurementPreview;
		const projectMeasurementPoint = (point, cursorScreen = null) => {
			if (!point || !Number.isFinite(point.time) || !Number.isFinite(point.price)) return null;

			// Second point while placing / dragging: exact cursor pixel.
			if (cursorScreen && Number.isFinite(cursorScreen.x) && Number.isFinite(cursorScreen.y)) {
				return {
					...point,
					x: cursorScreen.x,
					y: cursorScreen.y,
				};
			}

			const x = this.measurementTimeToX(point.time);
			const y = this.priceToY(point.price);

			return Number.isFinite(x) && Number.isFinite(y)
				? { ...point, x, y }
				: null;
		};
		const endFollowsCursor = Boolean(
			pointerPosition
			&& (
				(measurementStart && !measurementEnd)
				|| this.state.measurementDrag === "end"
			),
		);
		const startFollowsCursor = Boolean(
			pointerPosition && this.state.measurementDrag === "start",
		);
		const measurementA = projectMeasurementPoint(
			measurementStart,
			startFollowsCursor ? pointerPosition : null,
		);
		const measurementB = projectMeasurementPoint(
			measurementTarget,
			endFollowsCursor ? pointerPosition : null,
		);
		const measurement = measurementA && measurementB
			? {
				start: measurementA,
				end: measurementB,
				locked: Boolean(measurementEnd),
				rect: {
					x: Math.min(measurementA.x, measurementB.x),
					y: Math.min(measurementA.y, measurementB.y),
					width: Math.abs(measurementA.x - measurementB.x),
					height: Math.abs(measurementA.y - measurementB.y),
				},
			}
			: null;
		const measurementLabel = measurement
			? (() => {
				const delta = measurement.end.price - measurement.start.price;
				const percent = measurement.start.price
					? (delta / measurement.start.price) * 100
					: 0;
				const duration = formatMeasurementDuration(
					(measurement.end.time ?? 0) - (measurement.start.time ?? 0),
				);
				const percentText = `(${formatSignedPercent(percent)})`;
				const volumeBreakdown = this.getMeasurementAreaVolumeBreakdown(
					measurement.start,
					measurement.end,
					candles,
				);
				const volumeUsd = volumeBreakdown.totalUsd;
				const volumeText = Number.isFinite(volumeUsd)
					? `Vol . ${formatUsdValue(volumeUsd)}`
					: "Vol . --";
				const beforePercent = `${duration}  /  ${formatPrice(delta)}  `;
				const afterPercent = `  /  ${volumeText}`;
				const text = `${beforePercent}${percentText}${afterPercent}`;
				const volumeDeltaUsd = volumeBreakdown.deltaUsd;
				const volumeDeltaPercent = volumeBreakdown.deltaPercent;
				const hasVolumeDelta = (
					Number.isFinite(volumeDeltaUsd)
					&& Number.isFinite(volumeDeltaPercent)
				);
				const volumeDeltaUsdText = hasVolumeDelta
					? `${volumeDeltaUsd >= 0 ? "" : "-"}${formatUsdValue(Math.abs(volumeDeltaUsd))} `
					: "-- ";
				const volumeDeltaPercentText = hasVolumeDelta
					? `(${formatSignedPercent(volumeDeltaPercent)})`
					: "";
				const volumeDeltaText = `${volumeDeltaUsdText}${volumeDeltaPercentText}`.trim();
				const x = Math.min(
					chartSize.width - 10,
					Math.max(10, (measurement.start.x + measurement.end.x) / 2)
				);
				const y = Math.min(
					chartSize.height - 12,
					Math.max(18, measurement.rect.y - 8)
				);
				// Volume delta sits under the measurement rectangle, not under the top label.
				const volumeDeltaY = Math.min(
					chartSize.height - 4,
					Math.max(14, measurement.rect.y + measurement.rect.height + 14),
				);
				let textWidth = text.length * 7;
				let volumeDeltaWidth = volumeDeltaText.length * 7;

				if (!this.overlayTextMeasureContext && typeof document !== "undefined") {
					this.overlayTextMeasureContext = document.createElement("canvas").getContext("2d");
				}

				if (this.overlayTextMeasureContext) {
					this.overlayTextMeasureContext.font = "800 12px Inter";
					textWidth = this.overlayTextMeasureContext.measureText(text).width;
					this.overlayTextMeasureContext.font = "700 11px Inter";
					volumeDeltaWidth = this.overlayTextMeasureContext.measureText(volumeDeltaText).width;
				}

				const labelWidth = Math.max(textWidth, volumeDeltaWidth);

				return {
					x,
					y,
					volumeDeltaY,
					beforePercent,
					percentText,
					afterPercent,
					text,
					volumeDeltaUsdText,
					volumeDeltaPercentText,
					volumeDeltaText,
					isPercentPositive: percent >= 0,
					isVolumeDeltaPositive: Number.isFinite(volumeDeltaUsd) ? volumeDeltaUsd >= 0 : true,
					clearX: Math.min(
						chartSize.width - 10,
						Math.max(10, x - (labelWidth / 2) - 14),
					),
					clearY: Math.min(chartSize.height - 10, Math.max(10, y - 4)),
				};
			})()
			: null;
		const seriesPaneHeight = chartSize.height - CHART_TIME_SCALE_HEIGHT;
		const volumePaneBottom = (() => {
			const y = this.volumeSeries?.priceToCoordinate?.(0);

			return Number.isFinite(y) ? y : seriesPaneHeight;
		})();
		const hoveredVolumeCandle = Number.isInteger(hoveredVolumeIndex)
			? candles[hoveredVolumeIndex]
			: null;
		const hoveredVolumeValue = hoveredVolumeCandle
			? this.getCandleVolumeUsd(hoveredVolumeCandle)
			: null;
		const hoveredVolumeX = hoveredVolumeCandle ? this.timeToX(hoveredVolumeCandle.time) : null;
		const hoveredVolumeY = (
			this.volumeSeries
			&& Number.isFinite(hoveredVolumeValue)
			&& this.volumeSeries.priceToCoordinate
		)
			? this.volumeSeries.priceToCoordinate(hoveredVolumeValue)
			: null;
		const volumeHoverLabel = (
			Number.isFinite(hoveredVolumeX)
			&& Number.isFinite(hoveredVolumeY)
			&& Number.isFinite(hoveredVolumeValue)
		)
			? {
				x: Math.min(chartSize.width - 12, Math.max(12, hoveredVolumeX)),
				y: volumePaneBottom - 8,
				text: formatUsdValue(hoveredVolumeValue),
			}
			: null;
		const lims24 = showLims24Indicator ? this.getPriceLimits24h(candles) : null;
		const lims24Lines = lims24
			? (() => {
				const fromX = this.timeToX(lims24.fromTime);
				const toX = this.timeToX(lims24.toTime);
				const minY = this.priceToY(lims24.min);
				const maxY = this.priceToY(lims24.max);

				if (
					!Number.isFinite(fromX)
					|| !Number.isFinite(toX)
					|| !Number.isFinite(minY)
					|| !Number.isFinite(maxY)
				) {
					return null;
				}

				const x1 = Math.max(0, Math.min(fromX, toX));
				const x2 = Math.min(priceScaleLeft, Math.max(fromX, toX));

				if (x2 - x1 < 1) return null;

				const midX = (x1 + x2) / 2;
				const formatLimitLabel = (limitPrice) => {
					const priceLabel = this.formatOverlayPriceForProduct(limitPrice);
					if (!Number.isFinite(currentPrice) || currentPrice === 0) {
						return priceLabel;
					}

					const percent = ((limitPrice - currentPrice) / currentPrice) * 100;

					return `${priceLabel} (${formatSignedPercent(percent)})`;
				};

				return {
					x1,
					x2,
					minY,
					maxY,
					midX,
					highLabel: formatLimitLabel(lims24.max),
					lowLabel: formatLimitLabel(lims24.min),
				};
			})()
			: null;
		return (
			<svg
				className="e__market-overlay"
				width={priceScaleLeft}
				height={chartSize.height}
				style={{ width: priceScaleLeft }}
			>
				{freeCrosshairX !== null && (
					<line
						className="e__free-crosshair"
						x1={freeCrosshairX}
						x2={freeCrosshairX}
						y1={0}
						y2={chartSize.height}
					/>
				)}

				{currentX !== null && (
					<line
						className="e__current-candle-line"
						x1={currentX}
						x2={currentX}
						y1={0}
						y2={chartSize.height}
					/>
				)}

				{lims24Lines && (
					<g className="e__lims24">
						<line
							className="e__lims24-line"
							x1={lims24Lines.x1}
							x2={lims24Lines.x2}
							y1={lims24Lines.maxY}
							y2={lims24Lines.maxY}
						/>
						<text
							className="e__lims24-label"
							x={lims24Lines.midX}
							y={lims24Lines.maxY - 6}
							textAnchor="middle"
						>
							{lims24Lines.highLabel}
						</text>
						<line
							className="e__lims24-line"
							x1={lims24Lines.x1}
							x2={lims24Lines.x2}
							y1={lims24Lines.minY}
							y2={lims24Lines.minY}
						/>
						<text
							className="e__lims24-label"
							x={lims24Lines.midX}
							y={lims24Lines.minY + 14}
							textAnchor="middle"
						>
							{lims24Lines.lowLabel}
						</text>
					</g>
				)}

				{volumeHoverLabel && (
					<g className="e__volume-hover">
						<text x={volumeHoverLabel.x} y={volumeHoverLabel.y} textAnchor="middle">
							{volumeHoverLabel.text}
						</text>
					</g>
				)}

				{measurement && (
					<g className={`e__measurement ${measurement.locked ? "e__measurement--locked" : "e__measurement--preview"}`}>
						<rect
							className="e__measurement-fill"
							x={measurement.rect.x}
							y={measurement.rect.y}
							width={measurement.rect.width}
							height={measurement.rect.height}
							onPointerDown={
								measurement.locked
									? this.handleMeasurementMoveDragStart
									: undefined
							}
							onClick={event => event.stopPropagation()}
						/>
						{(() => {
							const midX = measurement.rect.x + (measurement.rect.width / 2);
							const midY = measurement.rect.y + (measurement.rect.height / 2);

							return (
								<>
									<line
										className="e__measurement-cross"
										x1={midX}
										x2={midX}
										y1={measurement.rect.y}
										y2={measurement.rect.y + measurement.rect.height}
									/>
									<line
										className="e__measurement-cross"
										x1={measurement.rect.x}
										x2={measurement.rect.x + measurement.rect.width}
										y1={midY}
										y2={midY}
									/>
								</>
							);
						})()}
						<circle
							className="e__measurement-handle"
							cx={measurement.start.x}
							cy={measurement.start.y}
							r={4}
							onPointerDown={event => this.handleMeasurementDragStart("start", event)}
							onClick={event => event.stopPropagation()}
						/>
						<circle
							className="e__measurement-handle"
							cx={measurement.end.x}
							cy={measurement.end.y}
							r={4}
							onPointerDown={event => this.handleMeasurementDragStart("end", event)}
							onClick={event => event.stopPropagation()}
						/>
						{measurementLabel && (
							<>
								<g
									className="e__measurement-clear"
									transform={`translate(${measurementLabel.clearX}, ${measurementLabel.clearY})`}
									role="button"
									tabIndex={0}
									aria-label="Clear measurement"
									onClick={this.handleMeasurementClear}
									onPointerDown={event => event.stopPropagation()}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											this.handleMeasurementClear(event);
										}
									}}
								>
									<circle r={7} />
									<path d="M -2.24 -2.24 L 2.24 2.24 M 2.24 -2.24 L -2.24 2.24" />
								</g>
								<text
									className="e__measurement-label"
									x={measurementLabel.x}
									y={measurementLabel.y}
									textAnchor="middle"
								>
									<tspan>{measurementLabel.beforePercent}</tspan>
									<tspan
										className={
											measurementLabel.isPercentPositive
												? "e__measurement-label__percent--up"
												: "e__measurement-label__percent--down"
										}
									>
										{measurementLabel.percentText}
									</tspan>
									<tspan>{measurementLabel.afterPercent}</tspan>
								</text>
								{measurementLabel.volumeDeltaText && (
									<text
										className="e__measurement-label e__measurement-label__volume-delta"
										x={measurementLabel.x}
										y={measurementLabel.volumeDeltaY}
										textAnchor="middle"
									>
										<tspan>{measurementLabel.volumeDeltaUsdText}</tspan>
										{measurementLabel.volumeDeltaPercentText && (
											<tspan
												className={
													measurementLabel.isVolumeDeltaPositive
														? "e__measurement-label__percent--up"
														: "e__measurement-label__percent--down"
												}
											>
												{measurementLabel.volumeDeltaPercentText}
											</tspan>
										)}
									</text>
								)}
							</>
						)}
					</g>
				)}

				<g className="e__distribution">
					{(distributionLine || countDistributionLine) && (
						<>
							<line
								className="e__distribution-axis"
								x1={profileLeft}
								x2={profileLeft}
								y1={0}
								y2={chartSize.height}
							/>
							{distributionLine && (
								<polyline className="e__distribution-line" points={distributionLine} />
							)}
							{countDistributionLine && (
								<polyline className="e__distribution-line e__distribution-line--count" points={countDistributionLine} />
							)}
						</>
					)}
				</g>

				{showDepthIndicator && currentY !== null && currentX !== null && (
					<g className="e__depth">
						{askLine && <polyline className="e__depth-ask" points={askLine} />}
						{bidLine && <polyline className="e__depth-bid" points={bidLine} />}
						{askTrail && (
							<g className="e__depth-trail e__depth-trail--ask">
								<circle cx={askTrail.x} cy={askTrail.y} r={5} />
								<text x={askTrailLabel.x} y={askTrailLabel.y} textAnchor={askTrailLabel.anchor}>
									{formatUsdValue(askTrail.cumulative)}
								</text>
							</g>
						)}
						{bidTrail && (
							<g className="e__depth-trail e__depth-trail--bid">
								<circle cx={bidTrail.x} cy={bidTrail.y} r={5} />
								<text x={bidTrailLabel.x} y={bidTrailLabel.y} textAnchor={bidTrailLabel.anchor}>
									{formatUsdValue(bidTrail.cumulative)}
								</text>
							</g>
						)}
						{depthHoverPoint && (
							<g className={`e__depth-hover e__depth-hover--${depthHoverPoint.side}`}>
								<circle cx={depthHoverPoint.x} cy={depthHoverPoint.y} r={6} />
								<text x={depthHoverLabel.x} y={depthHoverLabel.y} textAnchor={depthHoverLabel.anchor}>
									{`${formatPrice(depthHoverPoint.price)} / ${formatUsdValue(depthHoverPoint.cumulative)}`}
								</text>
							</g>
						)}
					</g>
				)}

				<g className="e__orders">
					{bookmarkedY !== null && (
						<g className="e__price-bookmark">
							<line x1={0} x2={bookmarkedLineRight} y1={bookmarkedY} y2={bookmarkedY} />
							<circle cx={bookmarkedLineRight} cy={bookmarkedY} r={3.5} />
							{bookmarkedPriceLabelLayout && bookmarkedLabelY !== null && (
								<text
									x={bookmarkedPriceLabelLayout.textX}
									y={bookmarkedLabelY}
									textAnchor="start"
								>
									{bookmarkedPriceLabel}
								</text>
							)}
							{bookmarkedPriceLabelLayout && bookmarkedLabelY !== null && (
								<g
									className="e__price-bookmark__delete"
									transform={`translate(${bookmarkedPriceLabelLayout.actionX}, ${bookmarkedLabelY - 4})`}
									role="button"
									tabIndex={0}
									onClick={this.clearBookmarkedPrice}
								>
									<circle r={7} />
									<path d="M -2.24 -2.24 L 2.24 2.24 M 2.24 -2.24 L -2.24 2.24" />
								</g>
							)}
						</g>
					)}
					{avgEntryY !== null && (
						<g className="e__avg-entry">
							<line x1={0} x2={avgEntryLineRight} y1={avgEntryY} y2={avgEntryY} />
							<circle cx={avgEntryLineRight} cy={avgEntryY} r={3.5} />
							{avgEntryPriceLabelLayout && avgEntryLabelY !== null && (
								<text
									x={avgEntryPriceLabelLayout.textX}
									y={avgEntryLabelY}
									textAnchor="start"
								>
									{avgEntryPriceLabel}
								</text>
							)}
						</g>
					)}
					{bagUsdLabelLayout && (
						<g className="e__bag-value">
							<text
								x={bagUsdLabelLayout.textX}
								y={Math.min(chartSize.height - 8, Math.max(12, currentY - 5))}
								textAnchor="start"
							>
								{bagUsdLabel}
							</text>
						</g>
					)}
					{orderTicketY !== null && (
						<g className={`e__order-ticket-marker e__order-ticket-marker--${orderTicket?.side === "SELL" ? "sell" : "buy"}`}>
							<line x1={0} x2={orderTicketLineRight} y1={orderTicketY} y2={orderTicketY} />
							{orderTicketScaleLabelY !== null && (
								<g className="e__order-ticket-marker__scale-label">
									<rect
										x={orderTicketScaleLabelX}
										y={orderTicketScaleLabelY}
										width={orderTicketScaleLabelWidth}
										height={orderTicketScaleLabelHeight}
										rx={4}
									/>
									<text
										x={orderTicketScaleLabelX + orderTicketScaleLabelWidth / 2}
										y={orderTicketScaleLabelY + 14}
										textAnchor="middle"
									>
										{this.getOrderPriceHandleLabel(orderTicketPriceValue, { showPercent: true })}
									</text>
								</g>
							)}
						</g>
					)}
					{orderTicketBracketMarkers.map(marker => (
						<g
							key={marker.id}
							className={`e__order-ticket-marker e__order-ticket-marker--${marker.role}`}
						>
							<line x1={0} x2={orderTicketLineRight} y1={marker.y} y2={marker.y} />
						</g>
					))}
					{orderTicketTrailingY !== null && (
						<g className="e__order-ticket-marker e__order-ticket-marker--trailing">
							<line x1={0} x2={orderTicketLineRight} y1={orderTicketTrailingY} y2={orderTicketTrailingY} />
						</g>
					)}
					{uniqueOrderLines.map(order => {
						const orderLabelId = `order:${order.original_id}:${order.role || "limit"}`;
						const labelY = overlayLabelYById.get(orderLabelId)
							?? Math.max(12, order.y - 5);
						const labelLayout = this.getOverlayLabelLayout(order.label, orderLineRight);

						return (
							<g
								key={orderLabelId}
								className={`e__order e__order--${order.side === "sell" ? "sell" : "buy"} ${order.role ? `e__order--${order.role.replace("_", "-")}` : ""} ${this.isTrailingOrderType(order.orderType) ? "e__order--trailing" : ""} ${isErrorOrderStatus(order.status) ? "e__order--error" : ""}`}
							>
								<line x1={0} x2={orderLineRight} y1={order.y} y2={order.y} />
								<circle cx={orderLineRight} cy={order.y} r={3.5} />
								<text x={labelLayout.textX} y={labelY} textAnchor="start">
									{order.label}
								</text>
								<g
									className="e__order-cancel"
									transform={`translate(${labelLayout.actionX}, ${labelY - 4})`}
									role="button"
									tabIndex={0}
									onClick={event => this.cancelOrder(order, event)}
								>
									<circle r={7} />
									<path d="M -2.24 -2.24 L 2.24 2.24 M 2.24 -2.24 L -2.24 2.24" />
								</g>
							</g>
						);
					})}
				</g>

				<g className="e__td-sequential">
					{tdSequentialBadges.map(marker => (
						<g
							key={`${marker.side}-${marker.time}-${marker.count}`}
							className={`e__td-sequential__marker e__td-sequential__marker--${marker.side} ${marker.complete ? "e__td-sequential__marker--complete" : ""}`}
						>
							<polygon points={marker.points} />
							<text x={marker.x} y={marker.textY} textAnchor="middle">
								{marker.text}
							</text>
						</g>
					))}
				</g>

			</svg>
		);
	};

	initChart = () => {
		const el = this.chartRef.current;

		if (!el) return;

		this.chart = createChart(el, {
			width: el.clientWidth,
			height: el.clientHeight,
			layout: {
				background: { color: 'transparent' },
				textColor: '#f2f6f8',
			},
			grid: {
				vertLines: { color: '#070b12' },
				horzLines: { color: '#070b12' },
			},
			localization: {
				timeFormatter: formatChartCrosshairTime,
			},
			rightPriceScale: {
				visible: true,
				autoScale: true,
				// !IMPORTANT DO NOT TOUCH. DO NOT OPTIMIZE UNLESS REQUESTED BY USER.
				// Always start Normal. Log cookie is applied after candle data has a
				// visible time range (armLogPriceScaleResyncAfterData).
				mode: PriceScaleMode.Normal,
				invertScale: this.state.isInvertedPriceScale,
				minimumWidth: 76,
				scaleMargins: { ...DEFAULT_PRICE_SCALE_MARGINS },
			},
			timeScale: {
				timeVisible: true,
				secondsVisible: false,
				borderColor: '#111820',
				rightOffset: 0,
				shiftVisibleRangeOnNewBar: true,
				...this.getTimeScaleBarSpacingOptions(el.clientWidth),
			},
			...this.getChartInteractionOptions(false),
			crosshair: {
				mode: CrosshairMode.Normal,
				vertLine: {
					visible: false,
					labelVisible: false,
				},
			},
		});

		this.candleSeries = this.chart.addSeries(
			CandlestickSeries,
			{
				upColor: '#20b28f',
				downColor: '#ee5858',
				borderVisible: false,
				wickUpColor: '#20b28f',
				wickDownColor: '#ee5858',
				crosshairMarkerVisible: false,
				autoscaleInfoProvider: this.getAutoscaleInfo,
				priceFormat: this.getPriceSeriesFormat(),
			}
		);
		// !IMPORTANT DO NOT TOUCH. DO NOT OPTIMIZE UNLESS REQUESTED BY USER.
		this.getMainPriceScale()?.applyOptions({
			mode: PriceScaleMode.Normal,
			invertScale: this.state.isInvertedPriceScale,
			autoScale: true,
		});

		this.tdSequentialSeries = this.chart.addSeries(
			LineSeries,
			{
				color: 'rgba(243, 215, 132, 0.38)',
				lineWidth: 1,
				lineType: LineType.WithSteps,
				visible: this.state.showTdIndicator,
				priceLineVisible: false,
				lastValueVisible: false,
				crosshairMarkerVisible: false,
				priceFormat: this.getPriceSeriesFormat(),
				autoscaleInfoProvider: this.getOverlayAutoscaleInfo,
			}
		);

		this.volumeSeries = this.chart.addSeries(
			HistogramSeries,
			{
				priceScaleId: 'volume',
				priceFormat: {
					type: 'custom',
					minMove: 0.01,
					formatter: formatUsdValue,
				},
			}
		);

		this.chart.priceScale('volume').applyOptions({
			scaleMargins: {
				top: 0.82,
				bottom: 0,
			},
		});

		if (this.chart.timeScale().subscribeVisibleLogicalRangeChange) {
			this.visibleRangeHandler = this.handleVisibleLogicalRangeChange;
			this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.visibleRangeHandler);
		}

		this.addChartInteractionListeners();
		this.handleResize();
	};

	render() {
		const classnames = classNames({
			"e__home": true,
		});

		const overlayBaseCurrency = this.state.baseCurrency.trim().toUpperCase();
		const isOverlayMarketLoaded = (
			!this.state.isLoading
			&& this.state.candles.length > 0
		);
		const hasOverlayPricePrecision = hasPriceIncrement(this.state.product?.quote_increment);
		const currentPrice = isOverlayMarketLoaded ? this.getOverlayMarketPrice() : NaN;
		const change24h = isOverlayMarketLoaded ? this.getOverlayPriceChange24h(currentPrice) : null;
		const volume24h = isOverlayMarketLoaded ? this.getVolume24h() : null;
		const changeClass = !change24h
			? ""
			: change24h.value >= 0
				? "e__price-overlay__change--up"
				: "e__price-overlay__change--down";
		const profileTotal = this.getProfileTotalUsdForDisplay();
		const profileBalances = Array.isArray(this.state.profile?.balances)
			? this.state.profile.balances
			: [];
		const orderTicket = this.state.orderTicket;
		const orderHover = this.state.orderScaleHover;
		const ticketAvailable = orderTicket ? this.getDisplayedBalanceForSide(orderTicket.side) : null;
		const ticketSide = orderTicket?.side === "SELL" ? "SELL" : "BUY";
		const ticketOrderType = this.normalizeOrderTypeForSide(ticketSide, orderTicket?.orderType);
		const ticketActionSideLabel = ticketSide.toLowerCase();
		const ticketBaseCurrency = String(this.state.baseCurrency || "").trim().toUpperCase();
		const ticketPrimaryOrderType = orderTicket
			? this.getTicketPrimaryOrderType({ ...orderTicket, orderType: ticketOrderType })
			: "LIMIT";
		const ticketStopOrderType = this.getSellStopOrderType(
			ticketPrimaryOrderType === "STOP"
				? ticketOrderType
				: orderTicket?.lastSellStopOrderType,
		);
		const ticketPriceValue = Number(orderTicket?.price);
		const ticketAmountValue = Number(orderTicket?.amount);
		const ticketSummaryPrice = ticketOrderType === "BRACKET"
			? Number(orderTicket?.takeProfitPrice)
			: ticketPriceValue;
		const ticketUsdTotal = orderTicket && Number.isFinite(ticketAmountValue) && ticketAmountValue > 0
			? orderTicket.amountMode === "USD"
				? ticketAmountValue
				: Number.isFinite(ticketSummaryPrice) && ticketSummaryPrice > 0
					? ticketAmountValue * ticketSummaryPrice
					: null
			: null;
		const ticketAvailableAmount = Number(ticketAvailable?.amount);
		const ticketAvailableLabel = ticketAvailable
			? `${ticketAvailable.currency === ticketBaseCurrency
				? this.getBaseAmountInputValue(ticketAvailableAmount)
				: formatBalanceAmount(ticketAvailableAmount)} ${ticketAvailable.currency}`
			: "--";
		const ticketPreviewMarketPrice = Number(orderTicket?.previewMarketPrice);
		const isSellMarketTicket = ticketSide === "SELL" && ticketOrderType === "MARKET";
		const isSellTicket = ticketSide === "SELL";
		const isSellCoinAmountTicket = isSellTicket && orderTicket?.amountMode === "BASE";
		const ticketMarketPriceLabel = (ticketSide === "BUY" || isSellMarketTicket) && ticketOrderType === "MARKET"
			? orderTicket?.isPreviewLoading
				? "..."
				: Number.isFinite(ticketPreviewMarketPrice) && ticketPreviewMarketPrice > 0
					? `${formatDisplayPriceWithIncrement(ticketPreviewMarketPrice, this.state.product?.quote_increment)} USD`
					: "--"
			: null;
		const ticketPreview = orderTicket?.preview || null;
		const ticketCurrentBody = orderTicket ? this.buildOrderTicketBody(orderTicket, { forPreview: true }).body : null;
		const ticketCurrentBodyKey = ticketCurrentBody ? JSON.stringify(ticketCurrentBody) : "";
		const ticketHasMatchingPreview = Boolean(
			ticketPreview
			&& orderTicket?.previewBodyKey === ticketCurrentBodyKey
		);
		const ticketHasValidPreview = ticketHasMatchingPreview && !orderTicket?.previewError;
		const previewMatchesAmount = Boolean(
			ticketPreview
			&& !orderTicket?.previewError
			&& orderTicket?.previewEnteredAmount !== null
			&& orderTicket?.previewEnteredAmount !== undefined
			&& String(orderTicket.previewEnteredAmount) === String(orderTicket.amount)
		);
		const ticketSummaryPending = Number.isFinite(ticketAmountValue) && ticketAmountValue > 0
			&& !previewMatchesAmount
			&& !orderTicket?.previewError;
		const isBuyUsdPayMode = ticketSide === "BUY" && orderTicket?.amountMode === "USD";
		const isSellUsdPayMode = ticketSide === "SELL" && orderTicket?.amountMode === "USD";
		const isBuyCoinAmountTicket = ticketSide === "BUY" && orderTicket?.amountMode === "BASE";
		const buyUsdPreviewSummary = isBuyUsdPayMode && Number.isFinite(ticketAmountValue) && ticketAmountValue > 0
			? getBuyUsdOrderTicketSummary(
				ticketAmountValue,
				previewMatchesAmount ? ticketPreview : null,
			)
			: null;
		// Sell: only use preview when body key matches (no stale amount-only reuse).
		const sellPreviewSummary = isSellTicket && ticketHasValidPreview
			? getSellPreviewTicketSummary(
				ticketPreview,
				isSellUsdPayMode ? ticketAmountValue : null,
			)
			: null;
		const sellSummaryReady = Boolean(sellPreviewSummary);
		const sellUsdEnteredTotal = isSellUsdPayMode && Number.isFinite(ticketAmountValue) && ticketAmountValue > 0
			? floorQuoteCurrencyAmount(ticketAmountValue)
			: NaN;
		const sellUsdEstimatedBase = isSellUsdPayMode
			&& Number.isFinite(ticketAmountValue)
			&& ticketAmountValue > 0
			&& Number.isFinite(ticketSummaryPrice)
			&& ticketSummaryPrice > 0
			? ticketAmountValue / ticketSummaryPrice
			: NaN;
		const ticketPreviewTotal = buyUsdPreviewSummary
			? buyUsdPreviewSummary.total
			: sellSummaryReady
				? sellPreviewSummary.total
				: isSellUsdPayMode
					? sellUsdEnteredTotal
					: isSellTicket
						? NaN
						: previewMatchesAmount
							? Number(ticketPreview?.order_total)
							: ticketUsdTotal;
		const ticketPreviewFee = buyUsdPreviewSummary
			? buyUsdPreviewSummary.fee
			: sellSummaryReady
				? sellPreviewSummary.fee
				: isSellTicket
					? NaN
					: previewMatchesAmount
						? Number(ticketPreview?.commission_total)
						: NaN;
		const ticketPreviewQuoteSize = buyUsdPreviewSummary
			? buyUsdPreviewSummary.value
			: sellSummaryReady
				? sellPreviewSummary.value
				: isSellTicket
					? NaN
					: previewMatchesAmount
						? Number(ticketPreview?.quote_size)
						: NaN;
		const ticketPreviewBaseSize = (isSellTicket ? ticketHasValidPreview : previewMatchesAmount)
			? getOrderPreviewBaseSize(ticketPreview)
			: NaN;
		const ticketPreviewTotalLabel = Number.isFinite(ticketPreviewTotal) && ticketPreviewTotal > 0
			? formatUsdCents(ticketPreviewTotal)
			: orderTicket?.isPreviewLoading && !isBuyUsdPayMode && !isSellTicket
				? "..."
				: "--";
		const ticketPreviewBaseAmountLabel = isSellCoinAmountTicket && Number.isFinite(ticketAmountValue) && ticketAmountValue > 0
			? `${this.getBaseAmountInputValue(ticketAmountValue)} ${ticketBaseCurrency}`
			: isSellUsdPayMode
				? sellSummaryReady
					&& Number.isFinite(ticketPreviewBaseSize)
					&& ticketPreviewBaseSize > 0
					? `${this.getBaseAmountInputValue(ticketPreviewBaseSize)} ${ticketBaseCurrency}`
					: Number.isFinite(sellUsdEstimatedBase) && sellUsdEstimatedBase > 0
						? `${this.getBaseAmountInputValue(sellUsdEstimatedBase)} ${ticketBaseCurrency}`
						: "--"
				: isBuyCoinAmountTicket && Number.isFinite(ticketAmountValue) && ticketAmountValue > 0
					? `${this.getBaseAmountInputValue(ticketAmountValue)} ${ticketBaseCurrency}`
					: previewMatchesAmount && Number.isFinite(ticketPreviewBaseSize) && ticketPreviewBaseSize > 0
						? `${this.getBaseAmountInputValue(ticketPreviewBaseSize)} ${ticketBaseCurrency}`
						: ticketSummaryPending || orderTicket?.isPreviewLoading
							? "..."
							: "--";
		const ticketPreviewFeeLabel = Number.isFinite(ticketPreviewFee)
			? formatUsdCents(ticketPreviewFee)
			: isSellTicket
				? "--"
				: (ticketSummaryPending || orderTicket?.isPreviewLoading)
					? "..."
					: "--";
		const ticketPreviewQuoteSizeLabel = (ticketSide === "BUY" || isSellTicket)
			? (
				isSellTicket
					? sellSummaryReady
					: previewMatchesAmount
			)
				&& Number.isFinite(ticketPreviewQuoteSize)
				&& ticketPreviewQuoteSize > 0
				? formatUsdCents(ticketPreviewQuoteSize)
				: isSellTicket
					? "--"
					: (ticketSummaryPending || orderTicket?.isPreviewLoading)
						? "..."
						: "--"
			: null;
		const isSellBracketTicket = ticketSide === "SELL" && ticketOrderType === "BRACKET";
		const ticketTakeProfitPrice = Number(orderTicket?.takeProfitPrice);
		const ticketStopLossPrice = Number(orderTicket?.stopLossPrice);
		const ticketBracketCoinAmount = isSellBracketTicket && Number.isFinite(ticketAmountValue) && ticketAmountValue > 0
			? orderTicket?.amountMode === "BASE"
				? ticketAmountValue
				: Number.isFinite(ticketTakeProfitPrice) && ticketTakeProfitPrice > 0
					? ticketAmountValue / ticketTakeProfitPrice
					: previewMatchesAmount && Number.isFinite(ticketPreviewBaseSize) && ticketPreviewBaseSize > 0
						? ticketPreviewBaseSize
						: NaN
			: NaN;
		const ticketBracketFee = ticketHasValidPreview
			? Number(ticketPreview?.commission_total)
			: NaN;
		const ticketBracketProfit = isSellBracketTicket
			? getBracketExitUsdValue({
				amount: ticketBracketCoinAmount,
				price: ticketTakeProfitPrice,
				referencePrice: ticketTakeProfitPrice,
				commissionTotal: ticketBracketFee,
				side: "sell",
			})
			: NaN;
		const ticketBracketLoss = isSellBracketTicket
			? getBracketExitUsdValue({
				amount: ticketBracketCoinAmount,
				price: ticketStopLossPrice,
				referencePrice: ticketTakeProfitPrice,
				commissionTotal: ticketBracketFee,
				side: "sell",
			})
			: NaN;
		const ticketBracketProfitLabel = isSellBracketTicket
			? Number.isFinite(ticketBracketProfit) && ticketBracketProfit > 0
				? formatUsdCents(ticketBracketProfit)
				: "--"
			: null;
		const ticketBracketLossLabel = isSellBracketTicket
			? Number.isFinite(ticketBracketLoss) && ticketBracketLoss > 0
				? formatUsdCents(ticketBracketLoss)
				: "--"
			: null;
		const ticketSliderDisabled = this.isOrderTicketZeroAvailable(orderTicket);
		const ticketSliderFraction = orderTicket
			? this.getOrderFractionFromAmount(orderTicket)
			: 0;
		const ticketAmountUnitLabel = orderTicket?.amountMode === "USD" ? "USD" : ticketBaseCurrency;
		const ticketPreviewWaitSeconds = this.getOrderPreviewWaitSeconds(orderTicket);
		const ticketActionLabel = orderTicket?.isSubmitting
			? "Placing..."
			: (
				`Place ${ticketActionSideLabel}${
					Number.isFinite(ticketPreviewWaitSeconds)
						? ` (${ticketPreviewWaitSeconds}s)`
						: ""
				}`
			);
		const ticketValidation = this.getOrderTicketValidation(orderTicket);
		const ticketVisibleError = ticketSliderDisabled
			? orderTicket?.error || ticketValidation.error
			: orderTicket?.error
				|| ticketValidation.error
				|| orderTicket?.previewError;
		const ticketMessageIsSuccess = String(ticketVisibleError).startsWith("Order placed");
		const orderTicketStyle = orderTicket ? this.getOrderTicketStyle(orderTicket) : null;
		const draggingPriceField = this.state.isOrderTicketPriceDragging
			? this.orderTicketPriceDragField
			: null;
		const draggingOpenOrderKey = this.state.openOrderDrag?.handleKey || "";
		let orderPriceHandles = [];

		if (
			orderTicket
			&& ticketOrderType === "LIMIT"
			&& Number.isFinite(ticketPriceValue)
			&& ticketPriceValue > 0
		) {
			const limitHandleY = this.priceToY(ticketPriceValue);

			if (Number.isFinite(limitHandleY)) {
				orderPriceHandles.push({
					key: "ticket:price",
					field: "price",
					tone: "limit",
					y: limitHandleY,
					label: this.getOrderPriceHandleLabel(ticketPriceValue, { showPercent: true }),
					ariaLabel: "Drag limit price",
					title: "Drag to change limit price",
					onPointerDown: event => this.handleOrderTicketPriceDragStart(event, "price"),
				});
			}
		}

		if (
			orderTicket
			&& ticketSide === "SELL"
			&& ticketOrderType === "BRACKET"
		) {
			if (Number.isFinite(ticketTakeProfitPrice) && ticketTakeProfitPrice > 0) {
				const takeProfitHandleY = this.priceToY(ticketTakeProfitPrice);

				if (Number.isFinite(takeProfitHandleY)) {
					orderPriceHandles.push({
						key: "ticket:takeProfitPrice",
						field: "takeProfitPrice",
						tone: "take-profit",
						y: takeProfitHandleY,
						label: this.getOrderPriceHandleLabel(ticketTakeProfitPrice, { showPercent: true }),
						ariaLabel: "Drag take profit price",
						title: "Drag to change take profit",
						onPointerDown: event => this.handleOrderTicketPriceDragStart(event, "takeProfitPrice"),
					});
				}
			}

			if (Number.isFinite(ticketStopLossPrice) && ticketStopLossPrice > 0) {
				const stopLossHandleY = this.priceToY(ticketStopLossPrice);

				if (Number.isFinite(stopLossHandleY)) {
					orderPriceHandles.push({
						key: "ticket:stopLossPrice",
						field: "stopLossPrice",
						tone: "stop-loss",
						y: stopLossHandleY,
						label: this.getOrderPriceHandleLabel(ticketStopLossPrice, { showPercent: true }),
						ariaLabel: "Drag stop loss price",
						title: "Drag to change stop loss",
						onPointerDown: event => this.handleOrderTicketPriceDragStart(event, "stopLossPrice"),
					});
				}
			}
		}

		const hideOpenOrderHandles = Boolean(orderTicket || this.state.isOrderTicketClosing);

		uniqueOrdersByOriginalId(this.getChartOrders())
			.filter(order => isOpenOrderStatus(order.status))
			.forEach(order => {
					const orderType = String(order.order_type || "").toUpperCase();
					const orderId = order.original_id;
					const size = this.getOpenOrderEditSize(order);
					const orderStatus = String(order.status || "").toUpperCase();
					const isErrorRow = orderStatus === "ERROR";
					const isMoveLocked = isErrorRow || this.isOpenOrderMoveLocked(order);
					const isPendingReplace = orderStatus === "PENDING" || isMoveLocked;

					if (!orderId) return;

					if (orderType === "LIMIT") {
						if ((!Number.isFinite(size) || size <= 0) && !isPendingReplace) return;

						const price = this.getLiveDragLinePrice(order, this.state.openOrderDrag);
						const y = this.priceToY(price);
						const handleKeyId = order.original_id;

						if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(y)) return;

						orderPriceHandles.push({
							key: this.getOpenOrderEditHandleKey(handleKeyId, "limit"),
							orderId,
							kind: "limit",
							price,
							tone: "limit",
							y,
							label: this.getOrderPriceHandleLabel(price, { showPercent: true }),
							ariaLabel: isMoveLocked
								? (orderStatus === "ERROR"
									? "Limit price cannot be edited"
									: "Limit price edit pending")
								: "Drag open limit price",
							title: isMoveLocked
								? (orderStatus === "ERROR"
									? "Order cannot be edited"
									: "Order update in progress")
								: "Drag to edit limit price",
							disabled: isMoveLocked,
							hideHandle: hideOpenOrderHandles,
							omitHandle: isErrorRow,
							onPointerDown: null,
						});
						return;
					}

					if (orderType !== "BRACKET" || !Array.isArray(order.bracket_legs)) return;

					order.bracket_legs.forEach(leg => {
						const kind = leg.role === "take_profit"
							? "take_profit"
							: leg.role === "stop_loss"
								? "stop_loss"
								: null;

						if (!kind) return;

						const legSizeCandidates = [
							leg.amount,
							leg.base_size,
							leg.total_base_size,
							size,
						];
						let legSize = null;
						for (const candidate of legSizeCandidates) {
							const value = Number(candidate);
							if (Number.isFinite(value) && value > 0) {
								legSize = value;
								break;
							}
						}
						const hasLegSize = legSize != null || isPendingReplace;

						if (!hasLegSize) return;

						const price = this.getLiveDragLinePrice(
							{ ...order, role: kind, price: Number(leg.price) },
							this.state.openOrderDrag,
						);
						const y = this.priceToY(price);

						if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(y)) return;

						orderPriceHandles.push({
							key: this.getOpenOrderEditHandleKey(
								order.original_id,
								kind,
							),
							orderId: order.original_id,
							kind,
							price,
							tone: kind === "take_profit" ? "take-profit" : "stop-loss",
							y,
							label: this.getOrderPriceHandleLabel(price, { showPercent: true }),
							ariaLabel: isMoveLocked
								? (orderStatus === "ERROR"
									? (kind === "take_profit" ? "Take profit cannot be edited" : "Stop loss cannot be edited")
									: (kind === "take_profit" ? "Take profit edit pending" : "Stop loss edit pending"))
								: (kind === "take_profit" ? "Drag open take profit price" : "Drag open stop loss price"),
							title: isMoveLocked
								? (orderStatus === "ERROR"
									? "Order cannot be edited"
									: "Order update in progress")
								: (kind === "take_profit" ? "Drag to edit take profit" : "Drag to edit stop loss"),
							disabled: isMoveLocked,
							hideHandle: hideOpenOrderHandles,
							omitHandle: isErrorRow,
							onPointerDown: null,
						});
					});
				});

		const uniqueHandles = new Map();
		orderPriceHandles.forEach(handle => {
			if (!handle?.key) return;
			uniqueHandles.set(handle.key, handle);
		});
		orderPriceHandles = Array.from(uniqueHandles.values());

		return (
			<div className={classnames} ref={this.container}>
				<header className="e__toolbar">
					<a
						className="e__toolbar-logo"
						href={getRoutePrefix(this.props.history.pathname) || "/"}
						aria-label="Home"
					>
						<svg
							viewBox="0 0 512 512"
							aria-hidden="true"
							focusable="false"
						>
							<path d="M205.2,81.9L33.1,380c-22.6,39,5.5,87,49.8,87c42.5,0,64.4-69.7,172.1-69.7c117.7,0,129.5,69.7,172.1,69.7c44.3,0,72.5-48,49.8-87L305.6,81.9C283.2,43,227.8,43,205.2,81.9z" />
						</svg>
					</a>
					<form className="e__market-form" onSubmit={this.handleProductSubmit}>
						<div className="e__market-form__row">
							<CoinsDropdown
								baseCurrency={this.state.baseCurrency}
								isClosing={this.state.closingDropdowns.monitor}
								isFiltering={this.state.isMonitorFiltering}
								isHovered={this.state.isCurrencyPickerHovered}
								isOpen={this.state.isMonitorOpen}
								monitorQuery={this.state.monitorQuery}
								monitorError={this.state.monitorError}
								onBlur={() => globalThis.setTimeout(() => {
									const active = document.activeElement;
									if (active?.closest?.(".e__currency-picker")) return;

									this.setState({
										isMonitorFiltering: false,
										monitorQuery: "",
									});
								}, 0)}
								onQueryChange={monitorQuery => this.setState({
									isMonitorFiltering: true,
									monitorQuery,
								})}
								onHoverChange={isCurrencyPickerHovered => this.setState({ isCurrencyPickerHovered })}
								onOpen={this.openMonitorDropdown}
								onTickerClick={this.handleMonitorTickerLinkClick}
								onToggle={this.toggleMonitorDropdown}
								tickers={this.state.monitorTickers}
							/>
							<button
								type="submit"
								onPointerDown={event => event.preventDefault()}
							>
								Apply
							</button>
							<button
								type="button"
								className={this.state.showHud ? "e__hud-toggle is-active" : "e__hud-toggle"}
								onClick={this.toggleHud}
								title={this.state.showHud ? "Hide HUD overlays" : "Show HUD overlays"}
								aria-label={this.state.showHud ? "Hide HUD overlays" : "Show HUD overlays"}
								aria-pressed={this.state.showHud}
							>
								HUD
							</button>
						</div>
					</form>

					<div className="e__profile">
						<button
							className="e__profile-refresh"
							type="button"
							onClick={this.forceRefreshAccount}
							disabled={this.state.isAccountRefreshing}
							aria-label="Refresh balances, orders, and depth range"
							title="Refresh balances, orders, and depth range"
						>
							<span className={this.state.isAccountRefreshing ? "e__profile-refresh-icon is-spinning" : "e__profile-refresh-icon"}>
								↻
							</span>
						</button>
						<OrdersDropdown
							error={this.state.allOrdersError}
							getSellOrderCoinsUsdValue={this.getSellOrderCoinsUsdValue}
							isClosing={this.state.closingDropdowns.orders}
							isLoading={this.state.isOrdersLoading}
							isOpen={this.state.isOrdersOpen}
							onCancelOrder={this.cancelOrder}
							onCurrencyClick={(event, currency) => this.handleCurrencyNavigationLinkClick(event, currency, "orders")}
							onToggle={() => this.setAnimatedDropdown("orders", !this.state.isOrdersOpen, {
								close: ["profile"],
								onOpen: this.loadAllOrders,
							})}
							orders={this.getOrdersForListDisplay(this.state.allOrders)}
						/>
						<BalanceDropdown
							balanceHistory={this.state.balanceHistory}
							balanceHistoryError={this.state.balanceHistoryError}
							balanceHistoryLoadedPeriod={this.state.balanceHistoryLoadedPeriod}
							balanceHistoryLoading={this.state.balanceHistoryLoading}
							balanceHistoryPeriod={this.state.balanceHistoryPeriod}
							appBookmarks={this.state.appBookmarks}
							balances={profileBalances}
							error={this.state.profileError}
							getBookmarkDelta={this.getBalanceBookmarkDelta}
							getBalanceUsdValue={this.getBalanceUsdValueForDisplay}
							getBookmarkedPrice={this.getBookmarkedPriceForCurrency}
							isClosing={this.state.closingDropdowns.profile}
							isLoading={this.state.isProfileLoading}
							isOpen={this.state.isProfileOpen}
							isRefreshing={this.state.isBalanceRefreshing}
							isHistoryColored={Boolean(this.state.appSettings.balanceHistoryColored)}
							isTotalExpanded={Boolean(this.state.appSettings.balanceHistoryExpanded)}
							onCurrencyClick={(event, currency) => this.handleCurrencyNavigationLinkClick(event, currency, "profile")}
							onClearBookmark={this.clearBookmarkedPriceForCurrency}
							onHistoryPeriodChange={this.setBalanceHistoryPeriod}
							onHistoryColoredChange={balanceHistoryColored => this.updateAppSettings({ balanceHistoryColored })}
							onTotalExpandedChange={balanceHistoryExpanded => this.updateAppSettings({ balanceHistoryExpanded })}
							onRefresh={this.refreshBalanceDropdown}
							onToggle={() => this.setAnimatedDropdown("profile", !this.state.isProfileOpen, {
								close: ["orders"],
								onOpen: () => {
									this.loadBalanceHistory();
									this.refreshBalanceDropdown();
								},
							})}
							total={profileTotal}
						/>
					</div>
				</header>

				<div
					className="e__chart-shell"
					onPointerMove={this.handleFreeCrosshairMove}
					onPointerLeave={this.handleChartShellLeave}
				>
					{this.state.chartNotice && (
						<div
							className={classNames(
								"e__chart-notice",
								`e__chart-notice--${this.state.chartNotice.tone || "info"}`,
								this.state.chartNotice.closing ? "is-closing" : "is-open",
							)}
							role="status"
							aria-live="polite"
						>
							{this.state.chartNotice.message}
						</div>
					)}
					<div className="e__chart" ref={this.chartRef} />
					{this.renderMacdOverlay()}
					{this.renderOverlay()}
					{(this.overlayReferenceLabels || []).map(item => (
						<div
							key={item.id}
							className={`e__reference-line-label-wrap e__reference-line-label-wrap--${item.tone}`}
							style={{ top: item.y }}
						>
							<span className="e__reference-line-label">{item.label}</span>
						</div>
					))}
					{orderPriceHandles.map(handle => (
						<div
							key={handle.key || handle.field}
							className={`e__order-price-handle-wrap e__order-price-handle-wrap--${handle.tone}`}
							style={{ top: handle.y }}
						>
							{!handle.omitHandle && <div
								className={`e__order-price-handle ${
									(
										!handle.disabled
										&& !handle.hideHandle
										&& (
											draggingPriceField === handle.field
											|| draggingOpenOrderKey === handle.key
										)
									) ? "is-dragging" : ""
								} ${
									this.state.openOrderEditErrorFlashKey === handle.key
										? "is-error-flash"
										: ""
								} ${
									handle.disabled ? "is-disabled" : ""
								}`}
								style={handle.hideHandle
									? { visibility: "hidden", pointerEvents: "none" }
									: undefined}
								onPointerDown={event => {
									if (handle.hideHandle || handle.disabled) {
										event.preventDefault();
										event.stopPropagation();
										return;
									}

									if (handle.onPointerDown) {
										handle.onPointerDown(event);
										return;
									}

									this.handleOpenOrderPriceDragStart(event, handle);
								}}
								role="group"
								aria-label={handle.ariaLabel}
								aria-disabled={handle.disabled || handle.hideHandle ? "true" : undefined}
								aria-hidden={handle.hideHandle ? "true" : undefined}
								title={handle.hideHandle ? undefined : handle.title}
							>
								<span className="e__order-price-handle__arrow" aria-hidden="true">▲</span>
								<span className="e__order-price-handle__arrow" aria-hidden="true">▼</span>
							</div>}
							<span className="e__order-price-handle__label">
								{handle.label}
							</span>
						</div>
					))}
					{orderHover && (
						<div
							className="e__scale-hover-actions"
							style={{
								left: orderHover.x,
								top: orderHover.y,
							}}
							onPointerEnter={this.handleOrderHoverEnter}
							onPointerMove={this.handleOrderHoverMove}
							onPointerLeave={this.handleOrderHoverLeave}
						>
							<button
								className="e__scale-hover-actions__bookmark"
								type="button"
								onClick={this.bookmarkOrderHoverPrice}
								title={`Bookmark ${this.formatChartPrice(orderHover.price)}`}
								aria-label="Bookmark price"
							>
								$
							</button>
							<button
								type="button"
								onClick={this.applyOrderHoverPrice}
								title={orderTicket ? `Set selected price to ${this.formatChartPrice(orderHover.price)}` : `Create order at ${this.formatChartPrice(orderHover.price)}`}
								aria-label={orderTicket ? "Set selected order price" : "Create order at price"}
							>
								+
							</button>
						</div>
					)}
					<OrderBubble
						amountUnitLabel={ticketAmountUnitLabel}
						isBalanceRefreshing={this.state.isBalanceRefreshing}
						isClosing={this.state.isOrderTicketClosing}
						isMoveDragging={this.state.isOrderTicketMoveDragging}
						isOrderTypeMenuOpen={this.state.isOrderTypeMenuOpen}
						messageIsSuccess={ticketMessageIsSuccess}
						onAmountBlur={this.formatOrderAmountInput}
						onAmountChange={this.updateOrderAmount}
						onAmountKeyDown={this.handleOrderAmountKeyDown}
						onBalanceRefresh={this.refreshOrderTicketBalance}
						onCancel={this.closeOrderTicket}
						onFractionChange={this.setOrderFraction}
						onFractionCommit={this.flushOrderPreview}
						onFractionPreset={this.applyOrderFractionPreset}
						onMoveDragStart={this.handleOrderTicketMoveDragStart}
						onOrderTypeMenuToggle={() => {
							if (ticketPrimaryOrderType !== "STOP") {
								this.setOrderType(ticketStopOrderType, { openMenu: true });
								return;
							}

							this.setState(prev => ({ isOrderTypeMenuOpen: !prev.isOrderTypeMenuOpen }));
						}}
						onPriceFieldChange={this.updateOrderPriceField}
						onPriceFieldFocus={field => this.updateOrderTicket({ activePriceField: field })}
						onSellStopOrderTypeChange={this.setSellStopOrderType}
						onSellStopOrderTypeSelect={() => {
							this.setOrderType(ticketStopOrderType, { closeMenu: true });
						}}
						onSideChange={this.switchOrderSide}
						onSubmit={this.submitOrderTicket}
						onTypeChange={this.setOrderType}
						onUnitToggle={this.toggleOrderAmountMode}
						orderTicket={orderTicket}
						orderTicketRef={this.orderTicketRef}
						orderTicketStyle={orderTicketStyle}
						previewBaseAmountLabel={ticketPreviewBaseAmountLabel}
						previewBracketLossLabel={ticketBracketLossLabel}
						previewBracketProfitLabel={ticketBracketProfitLabel}
						previewFeeLabel={ticketPreviewFeeLabel}
						previewQuoteSizeLabel={ticketPreviewQuoteSizeLabel}
						previewTotalLabel={ticketPreviewTotalLabel}
						sliderDisabled={ticketSliderDisabled}
						sliderFraction={ticketSliderFraction}
						submitLabel={ticketActionLabel}
						ticketAvailableLabel={ticketAvailableLabel}
						ticketMarketPriceLabel={ticketMarketPriceLabel}
						ticketOrderType={ticketOrderType}
						ticketPrimaryOrderType={ticketPrimaryOrderType}
						ticketStopOrderType={ticketStopOrderType}
						ticketSide={ticketSide}
						visibleError={ticketVisibleError}
					/>
					<div className={this.state.showHud ? "e__price-overlay" : "e__price-overlay is-hud-hidden"}>
						<div className="e__price-overlay__meta">
							<span className={`e__live-dot ${this.state.isLive ? "e__live-dot--live" : "e__live-dot--offline"}`} />
							<span className="e__price-overlay__label">
								{`${overlayBaseCurrency}-USD`}
							</span>
						</div>
						<div className="e__price-overlay__price">
							{isOverlayMarketLoaded && hasOverlayPricePrecision
								? formatDisplayPriceWithIncrement(currentPrice, this.state.product.quote_increment)
								: "--"}
						</div>
						<div className="e__price-overlay__stats">
							<span className={`e__price-overlay__change ${changeClass}`}>
								{change24h
									? formatSignedPercent(change24h.percent)
									: "--"}
							</span>
							<span className="e__price-overlay__volume">
								{volume24h !== null ? formatUsdValue(volume24h) : "--"}
							</span>
						</div>
					</div>

					<div
						className={this.state.showHud ? "e__indicator-toggles" : "e__indicator-toggles is-hud-hidden"}
						ref={this.indicatorTogglesRef}
						aria-label="Chart indicators"
						aria-hidden={this.state.showHud ? undefined : "true"}
					>
						<button
							type="button"
							className={this.state.showDepthIndicator ? "e__indicator-toggle is-active" : "e__indicator-toggle"}
							onClick={() => this.toggleIndicator("depth")}
							title="Toggle depth overlay"
							aria-label="Toggle depth overlay"
							aria-pressed={this.state.showDepthIndicator}
						>
							DEPTH
						</button>
						<button
							type="button"
							className={this.state.showTdIndicator ? "e__indicator-toggle is-active" : "e__indicator-toggle"}
							onClick={() => this.toggleIndicator("td")}
							aria-pressed={this.state.showTdIndicator}
						>
							TD
						</button>
						<button
							type="button"
							className={this.state.showVwapIndicator ? "e__indicator-toggle is-active" : "e__indicator-toggle"}
							onClick={() => this.toggleIndicator("vwap")}
							aria-pressed={this.state.showVwapIndicator}
						>
							VWAP
						</button>
						<button
							type="button"
							className={this.state.showBagValueIndicator ? "e__indicator-toggle is-active" : "e__indicator-toggle"}
							onClick={() => this.toggleIndicator("bag")}
							title="Toggle bag value (coins × live price)"
							aria-label="Toggle bag value"
							aria-pressed={this.state.showBagValueIndicator}
						>
							$$$
						</button>
						<button
							type="button"
							className={this.state.showVolhIndicator ? "e__indicator-toggle is-active" : "e__indicator-toggle"}
							onClick={() => this.toggleIndicator("volh")}
							title="Toggle volume-weighted price histogram"
							aria-label="Toggle volume-weighted histogram"
							aria-pressed={this.state.showVolhIndicator}
						>
							VOLH
						</button>
						<button
							type="button"
							className={this.state.showPrchIndicator ? "e__indicator-toggle is-active" : "e__indicator-toggle"}
							onClick={() => this.toggleIndicator("prch")}
							title="Toggle price-touch count histogram"
							aria-label="Toggle price-count histogram"
							aria-pressed={this.state.showPrchIndicator}
						>
							PRCH
						</button>
						<button
							type="button"
							className={this.state.showMacdIndicator ? "e__indicator-toggle is-active" : "e__indicator-toggle"}
							onClick={() => this.toggleIndicator("macd")}
							title="Toggle MACD (12, 26, 9)"
							aria-label="Toggle MACD"
							aria-pressed={this.state.showMacdIndicator}
						>
							MACD
						</button>
						<button
							type="button"
							className={this.state.showPvtIndicator ? "e__indicator-toggle is-active" : "e__indicator-toggle"}
							onClick={() => this.toggleIndicator("pvt")}
							title="Toggle price volume trend"
							aria-label="Toggle price volume trend"
							aria-pressed={this.state.showPvtIndicator}
						>
							PVT
						</button>
						<button
							type="button"
							className={this.state.showLims24Indicator ? "e__indicator-toggle is-active" : "e__indicator-toggle"}
							onClick={() => this.toggleIndicator("lims24")}
							title="Toggle 24h high and low limits"
							aria-label="Toggle 24h high and low limits"
							aria-pressed={this.state.showLims24Indicator}
						>
							LIMS24
						</button>
					</div>

					<div
						className={this.state.showHud ? "e__chart-bottom-controls" : "e__chart-bottom-controls is-hud-hidden"}
						ref={this.chartBottomControlsRef}
						aria-hidden={this.state.showHud ? undefined : "true"}
					>
						<button
							type="button"
							className={`e__frame-24h-button ${this.state.isBullseyeViewActive ? "is-active" : ""}`}
							onClick={this.toggleBullseyeView}
							title={this.state.isBullseyeViewActive ? "Exit Bullseye view" : "Enter Bullseye view"}
							aria-label={this.state.isBullseyeViewActive ? "Exit Bullseye view" : "Enter Bullseye view"}
							aria-pressed={this.state.isBullseyeViewActive}
						>
							<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
								<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
								<circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" strokeWidth="1.75" />
								<circle cx="12" cy="12" r="1.5" fill="currentColor" />
							</svg>
						</button>

						<div
							className="e__timeframe-controls"
							ref={this.timeframeControlsRef}
							aria-label="Candle timeframe"
						>
							<button
								type="button"
								className={(this.state.isCandleGranularityMenuOpen && !this.state.isCandleGranularityMenuClosing) ? "is-active is-open" : ""}
								onClick={this.toggleCandleGranularityMenu}
								aria-expanded={this.state.isCandleGranularityMenuOpen && !this.state.isCandleGranularityMenuClosing}
								aria-haspopup="listbox"
								title="Candle timeframe"
							>
								{getCandleGranularityLabel(this.state.periodGranularity)}
								<span className="e__dropdown-icon" aria-hidden="true" />
							</button>
							{(this.state.isCandleGranularityMenuOpen || this.state.isCandleGranularityMenuClosing) && (
								<div
									className={`e__timeframe-controls__menu ${this.state.isCandleGranularityMenuClosing ? "is-closing" : "is-open"}`}
									role="listbox"
								>
									{CANDLE_GRANULARITY_OPTIONS.map(option => (
										<button
											key={option.seconds}
											type="button"
											role="option"
											aria-selected={Number(this.state.periodGranularity) === option.seconds}
											className={Number(this.state.periodGranularity) === option.seconds ? "is-active" : ""}
											onClick={() => this.setCandleGranularity(option.seconds)}
										>
											{option.label}
										</button>
									))}
								</div>
							)}
						</div>

						<div className="e__scale-controls" ref={this.scaleControlsRef} aria-label="Price scale controls">
							<button
								type="button"
								onClick={this.enablePriceAutoScale}
								title="Autoscale price"
								aria-label="Autoscale price"
							>
								AUTO
							</button>
							<button
								type="button"
								className={this.state.isLogPriceScale ? "is-active" : ""}
								onClick={this.toggleLogPriceScale}
								title="Toggle logarithmic price scale"
								aria-label="Toggle logarithmic price scale"
								aria-pressed={this.state.isLogPriceScale}
							>
								LOG
							</button>
							<button
								type="button"
								className={this.state.isInvertedPriceScale ? "is-active" : ""}
								onClick={this.toggleInvertedPriceScale}
								title="Invert price scale"
								aria-label="Invert price scale"
								aria-pressed={this.state.isInvertedPriceScale}
							>
								INV
							</button>
						</div>
					</div>

					{this.state.isLoading && !this.state.error && (
						<div className="e__loading-notice">
							Loading
						</div>
					)}
					{this.state.error && (
						<div className="e__error">
							{this.state.error}
						</div>
					)}
					{!this.state.error && this.state.orderError && (
						<div className="e__order-error">
							{this.state.orderError}
						</div>
					)}
					{!this.state.error && !this.state.orderError && this.state.tdSequentialError && (
						<div className="e__order-error">
							{this.state.tdSequentialError}
						</div>
					)}
				</div>
			</div>
		);
	}
}
