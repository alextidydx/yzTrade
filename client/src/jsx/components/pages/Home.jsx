import React from 'react';
import classNames from "classnames";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import * as api from "../../../api";
import '../../../styles/ui/home.scss';
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
	PriceScaleMode,
} from 'lightweight-charts';

import {
	DEFAULT_DEPTH_CHART_WIDTH_RATIO,
	DEFAULT_PERIOD_DAYS,
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
	PEAK_THRESHOLD,
	PRICE_MIN_MOVE,
	PRICE_SCALE_COOKIES,
	TD_REFRESH_RETRY_DELAYS,
	TD_TIMEFRAME_SECONDS,
} from "../../../utils/homeConstants";

import {
	deleteBookmarkedPrice,
	formatAmountWithIncrementFloor,
	formatBalanceAmount,
	formatDisplayPriceWithIncrement,
	formatMeasurementDuration,
	formatOrderValue,
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
	getCookieBoolean,
	buildOptimisticOrderFromPlacement,
	enrichOrderForDisplay,
	filterOrdersForChartProduct,
	floorQuoteCurrencyAmount,
	getBuyUsdOrderTicketSummary,
	getBuyUsdPreviewQuoteSize,
	getSellPreviewTicketSummary,
	getOrderPreviewBaseSize,
	getOrderErrorLabel,
	isOpenOrderStatus,
	isRemovedLiveOrder,
	mergeOrderFields,
	normalizeBalanceHistoryPeriod,
	normalizeBookmarkPrice,
	getPrecisionFromIncrement,
	getRoutePrefix,
	getVwapSessionKey,
	getWebSocketBase,
	hasPriceIncrement,
	sanitizeNumericInput,
	setBookmarkedPrice,
	setCookieBoolean,
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

class Home extends React.Component {
	container = React.createRef();
	chartRef = React.createRef();
	orderTicketRef = React.createRef();
	indicatorTogglesRef = React.createRef();
	scaleControlsRef = React.createRef();

	state = {
		candles: [],
		historicalCandles: [],
		currentCandle: null,
		depth: null,
		orders: [],
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
		appSettings: {
			balanceHistoryExpanded: false,
			balanceHistoryPeriod: "week",
		},
		isMonitorOpen: false,
		isCurrencyPickerHovered: false,
		isAccountRefreshing: false,
		error: "",
		isLive: false,
		isLoading: true,
		isLoadingOlderCandles: false,
		hasMoreOlderCandles: true,
		isLogPriceScale: getCookieBoolean(PRICE_SCALE_COOKIES.logarithmic, false),
		isInvertedPriceScale: getCookieBoolean(PRICE_SCALE_COOKIES.inverted, false),
		showTdIndicator: getCookieBoolean(INDICATOR_COOKIES.td, true),
		showVwapIndicator: getCookieBoolean(INDICATOR_COOKIES.vwap, true),
		showHistogramIndicator: getCookieBoolean(INDICATOR_COOKIES.histogram, true),
		baseCurrency: getBaseCurrencyFromPath(window.location.pathname),
		periodDays: DEFAULT_PERIOD_DAYS,
		periodGranularity: 300,
		loadedBaseCurrency: getBaseCurrencyFromPath(window.location.pathname),
		loadedPeriodDays: DEFAULT_PERIOD_DAYS,
		loadedPeriodGranularity: 300,
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
		orderTicket: null,
		isOrderTicketClosing: false,
		lastOrderSide: "BUY",
		savedOrderTickets: {
			BUY: null,
			SELL: null,
		},
		overlayTick: 0,
	};

	chart = null;
	candleSeries = null;
	volumeSeries = null;
	tdSequentialSeries = null;
	vwapSeries = [];
	overlayFrame = null;
	priceScaleWheelFrame = null;
	priceScaleWheelState = null;
	priceScaleWheelOverlayTimer = null;
	visibleRangeHandler = null;
	isCrosshairTimeLabelVisible = false;
	liveSocket = null;
	liveProductId = null;
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
	tdRefreshTimers = [];
	lastTdRefreshBoundary = null;
	tdRefreshInFlight = false;
	marketRequestId = 0;
	candleRollRequestId = 0;
	isMarketTransitioning = false;
	isDisconnectingLive = false;
	suppressMeasurementClick = false;
	profileRequestId = 0;
	profileRefreshAfterOrderTimers = [];
	dropdownCloseTimers = {};
	orderTicketCloseTimer = null;
	orderPreviewTimer = null;
	orderPreviewRequestId = 0;
	marketPreviewPollTimer = null;
	lastMarketPreviewAt = 0;
	marketPreviewRequestPrice = null;

	componentDidMount() {
		window.addEventListener('resize', this.handleResize);
		window.addEventListener('keydown', this.handleKeyDown);
		window.addEventListener('pointermove', this.handleMeasurementDragMove);
		window.addEventListener('pointerup', this.handleMeasurementDragEnd);
		document.addEventListener('pointerdown', this.handleDocumentPointerDown);
		this.initChart();
		this.loadAppState();
		this.connectAppStateSocket();
		this.bootstrapFromConfig();
		this.loadBalanceHistory();
		this.profileRefreshTimer = window.setInterval(this.loadProfile, 60000);
		this.allOrdersRefreshTimer = window.setInterval(this.loadAllOrders, 5000);
		this.balanceHistoryRefreshTimer = window.setInterval(this.loadBalanceHistory, 60000);
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
				loadedBaseCurrency: pathCurrency,
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
			|| prevState.loadedBaseCurrency !== this.state.loadedBaseCurrency
			|| prevState.product !== this.state.product
		) {
			this.updateDocumentTitle();
		}

		if (
			prevState.showTdIndicator !== this.state.showTdIndicator
			|| prevState.showVwapIndicator !== this.state.showVwapIndicator
			|| prevState.showHistogramIndicator !== this.state.showHistogramIndicator
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

			return;
		}

		const baseCurrency = getBaseCurrencyFromPath(
			this.props.history.pathname,
			this.state.defaultBaseCurrency,
		);

		if (baseCurrency === this.state.baseCurrency) return;

		this.setState({ baseCurrency }, () => {
			this.loadMarket();
			this.loadProfile();
			this.loadAllOrders();
		});
	}

	updateDocumentTitle = () => {
		const lastCandle = this.state.candles[this.state.candles.length - 1];
		const price = Number(lastCandle?.close);
		const currency = this.state.loadedBaseCurrency || this.state.baseCurrency;

		document.title = Number.isFinite(price)
			? `${formatPriceWithIncrement(price, this.state.product?.quote_increment)} ${currency}`
			: `${currency} Trade`;
	};

	componentWillUnmount() {
		window.removeEventListener('resize', this.handleResize);
		window.removeEventListener('keydown', this.handleKeyDown);
		window.removeEventListener('pointermove', this.handleMeasurementDragMove);
		window.removeEventListener('pointerup', this.handleMeasurementDragEnd);
		document.removeEventListener('pointerdown', this.handleDocumentPointerDown);
		this.removeChartInteractionListeners();
		this.disconnectLiveMarket();
		this.disconnectAppStateSocket();

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

		if (this.priceScaleWheelFrame) {
			cancelAnimationFrame(this.priceScaleWheelFrame);
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

		if (this.balanceHistoryRefreshTimer) {
			window.clearInterval(this.balanceHistoryRefreshTimer);
		}

		if (this.monitorRefreshTimer) {
			window.clearInterval(this.monitorRefreshTimer);
		}

		if (this.productStatsRefreshTimer) {
			window.clearInterval(this.productStatsRefreshTimer);
		}

		this.clearLiveFlushTimer();

		Object.values(this.dropdownCloseTimers).forEach(timer => window.clearTimeout(timer));
		if (this.orderTicketCloseTimer) {
			window.clearTimeout(this.orderTicketCloseTimer);
		}

		this.profileRefreshAfterOrderTimers.forEach(timer => window.clearTimeout(timer));
		this.profileRefreshAfterOrderTimers = [];

		if (this.orderPreviewTimer) {
			window.clearTimeout(this.orderPreviewTimer);
		}

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
			this.setState(prev => ({
				overlayTick: prev.overlayTick + 1,
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

		const dropdownsToClose = ["monitor", "orders", "profile"].filter(name => nextState[name]);

		if (dropdownsToClose.length) {
			this.closeAnimatedDropdowns(dropdownsToClose);
		}

		if (nextState.isOrderTypeMenuOpen === false) {
			this.setState({
				...(nextState.isOrderTypeMenuOpen === false ? { isOrderTypeMenuOpen: false } : {}),
			});
		}
	};

	handleVisibleLogicalRangeChange = (range) => {
		this.scheduleOverlayUpdate();

		if (!range || !Number.isFinite(range.from) || range.from > 24) return;

		this.loadOlderCandles();
	};

	addChartInteractionListeners = () => {
		const el = this.chartRef.current;
		if (!el) return;

		this.chartInteractionEvents = [
			"pointerdown",
			"pointermove",
			"pointerup",
			"pointerleave",
			"touchmove",
		];

		this.chartInteractionEvents.forEach(eventName => {
			el.addEventListener(eventName, this.scheduleOverlayUpdate, { passive: true });
		});

		el.addEventListener("pointermove", this.handleFreeCrosshairMove, { passive: true });
		el.addEventListener("mousemove", this.handleFreeCrosshairMove, { passive: true });
		el.addEventListener("pointerleave", this.handleFreeCrosshairLeave, { passive: true });
		el.addEventListener("mouseleave", this.handleFreeCrosshairLeave, { passive: true });
		el.addEventListener("wheel", this.handlePriceScaleWheel, { passive: false, capture: true });
		el.addEventListener("click", this.handleMeasurementClick);
	};

	removeChartInteractionListeners = () => {
		const el = this.chartRef.current;
		if (!el || !this.chartInteractionEvents) return;

		this.chartInteractionEvents.forEach(eventName => {
			el.removeEventListener(eventName, this.scheduleOverlayUpdate);
		});

		el.removeEventListener("pointermove", this.handleFreeCrosshairMove);
		el.removeEventListener("mousemove", this.handleFreeCrosshairMove);
		el.removeEventListener("pointerleave", this.handleFreeCrosshairLeave);
		el.removeEventListener("mouseleave", this.handleFreeCrosshairLeave);
		el.removeEventListener("wheel", this.handlePriceScaleWheel, true);
		el.removeEventListener("click", this.handleMeasurementClick);
	};

	handleKeyDown = (event) => {
		if (event.key !== "Escape") return;

		if (this.state.measurementStart || this.state.measurementEnd) {
			this.setState({
				measurementStart: null,
				measurementEnd: null,
				measurementDrag: null,
			});
		}
	};

	getMeasurementPointFromCoordinates = (x, y) => {
		if (!this.chart || !this.candleSeries) return null;

		const logical = this.chart.timeScale().coordinateToLogical?.(x);
		const price = this.candleSeries.coordinateToPrice(y);

		if (!Number.isFinite(logical) || !Number.isFinite(price)) return null;

		return {
			logical,
			price,
			time: this.logicalToTime(logical),
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

	handleMeasurementDragStart = (endpoint, event) => {
		event.preventDefault();
		event.stopPropagation();

		this.suppressMeasurementClick = true;
		this.setState({ measurementDrag: endpoint });
	};

	handleMeasurementDragMove = (event) => {
		const { measurementDrag } = this.state;
		if (!measurementDrag) return;

		const point = this.getMeasurementPointFromEvent(event);
		if (!point) return;

		this.setState({
			[measurementDrag === "start" ? "measurementStart" : "measurementEnd"]: point,
		});
	};

	handleMeasurementDragEnd = () => {
		if (!this.state.measurementDrag) return;

		this.setState({ measurementDrag: null });
		window.setTimeout(() => {
			this.suppressMeasurementClick = false;
		}, 0);
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

		if (event.cancelable) event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation?.();

		// Log-mode Y wheel is unreliable; use price-axis drag instead.
		if (this.state.isLogPriceScale) return;

		const y = event.clientY - rect.top;
		this.priceScaleWheelState = {
			deltaY: (this.priceScaleWheelState?.deltaY || 0) + event.deltaY,
			y,
		};

		if (this.priceScaleWheelFrame) return;

		this.priceScaleWheelFrame = requestAnimationFrame(() => {
			this.priceScaleWheelFrame = null;
			this.applyPriceScaleWheel();
		});
	};

	applyPriceScaleWheel = () => {
		if (!this.chart || !this.candleSeries || !this.priceScaleWheelState) return;

		const priceScale = this.chart.priceScale('right');
		const range = priceScale.getVisibleRange?.();
		const { deltaY, y } = this.priceScaleWheelState;

		this.priceScaleWheelState = null;

		if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || deltaY === 0) return;

		const lower = Math.min(range.from, range.to);
		const upper = Math.max(range.from, range.to);
		const rawAnchorPrice = this.candleSeries.coordinateToPrice(y) ?? ((lower + upper) / 2);
		const anchorPrice = Math.min(upper, Math.max(lower, rawAnchorPrice));
		const zoomFactor = Math.exp(Math.sign(deltaY) * Math.min(Math.abs(deltaY), 180) / 1600);
		let nextFrom = anchorPrice - (anchorPrice - lower) * zoomFactor;
		let nextTo = anchorPrice + (upper - anchorPrice) * zoomFactor;

		if (!Number.isFinite(nextFrom) || !Number.isFinite(nextTo) || nextFrom === nextTo) return;

		priceScale.applyOptions({ autoScale: false });
		priceScale.setVisibleRange({
			from: Math.min(nextFrom, nextTo),
			to: Math.max(nextFrom, nextTo),
		});

		if (this.priceScaleWheelOverlayTimer) {
			window.clearTimeout(this.priceScaleWheelOverlayTimer);
			this.priceScaleWheelOverlayTimer = null;
		}

		this.scheduleOverlayUpdate();
	};

	enablePriceAutoScale = () => {
		this.getMainPriceScale()?.applyOptions({ autoScale: true });
		this.scheduleOverlayUpdate();
	};

	getMainPriceScale = () => (
		this.candleSeries?.priceScale?.()
		|| this.chart?.priceScale('right')
	);

	toggleLogPriceScale = () => {
		this.setState(prev => {
			const isLogPriceScale = !prev.isLogPriceScale;

			this.getMainPriceScale()?.applyOptions({
				mode: isLogPriceScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
				autoScale: true,
			});
			setCookieBoolean(PRICE_SCALE_COOKIES.logarithmic, isLogPriceScale);

			return { isLogPriceScale };
		}, this.scheduleOverlayUpdate);
	};

	toggleInvertedPriceScale = () => {
		this.setState(prev => {
			const isInvertedPriceScale = !prev.isInvertedPriceScale;

			this.getMainPriceScale()?.applyOptions({
				invertScale: isInvertedPriceScale,
				autoScale: true,
			});
			setCookieBoolean(PRICE_SCALE_COOKIES.inverted, isInvertedPriceScale);

			return { isInvertedPriceScale };
		}, this.scheduleOverlayUpdate);
	};

	getHoveredCandleIndexFromX = (x) => {
		const { candles } = this.state;

		if (!this.chart || !Array.isArray(candles) || !candles.length || !Number.isFinite(x)) {
			return null;
		}

		let bestIndex = null;
		let bestDistance = Infinity;
		const visibleLogicalRange = this.chart.timeScale().getVisibleLogicalRange?.();
		const from = visibleLogicalRange && Number.isFinite(visibleLogicalRange.from)
			? Math.max(0, Math.floor(visibleLogicalRange.from) - 2)
			: 0;
		const to = visibleLogicalRange && Number.isFinite(visibleLogicalRange.to)
			? Math.min(candles.length - 1, Math.ceil(visibleLogicalRange.to) + 2)
			: candles.length - 1;

		for (let index = from; index <= to; index++) {
			const candleX = this.timeToX(candles[index].time);

			if (!Number.isFinite(candleX)) continue;

			const distance = Math.abs(candleX - x);

			if (distance < bestDistance) {
				bestDistance = distance;
				bestIndex = index;
			}
		}

		return bestIndex;
	};

	getCrosshairTimeFromX = (x) => {
		const candles = this.state.candles;
		const fallbackTime = candles[candles.length - 1]?.time;
		const logical = this.chart?.timeScale?.().coordinateToLogical?.(x);
		const time = this.logicalToTime(logical);

		return Number.isFinite(time) ? time : fallbackTime;
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
		const el = this.chartRef.current;
		if (!el) return;

		const rect = el.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
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

		if (x < 0 || x > rect.width) {
			this.handleFreeCrosshairLeave();
			return;
		}

		this.setCrosshairTimeLabelVisible(isOverCandleZone);

		const nextHoveredVolumeIndex = isOverCandleZone
			? this.getHoveredCandleIndexFromX(x)
			: null;

		if (nextHoveredVolumeIndex !== this.state.hoveredVolumeIndex) {
			this.syncVolumeSeries(this.state.candles, nextHoveredVolumeIndex);
		}

		if (orderScaleHover) {
			this.syncNativeCrosshair(orderScaleHover.price, Math.min(x, scaleLeft - 1));
		} else if (isMovingTowardOrderHover && Number.isFinite(bridgePrice)) {
			this.syncNativeCrosshair(bridgePrice, hover.x);
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
		this.setState({ chartSize: { width, height } });
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
		if (!this.chart || !snapshot) return false;

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

	restoreVisibleTimeframeByDates = (snapshot, candles) => {
		if (!this.chart || !snapshot?.timeRange || !Array.isArray(candles) || !candles.length) return false;

		const requestedFrom = Number(snapshot.timeRange.from);
		const requestedTo = Number(snapshot.timeRange.to);
		const duration = requestedTo - requestedFrom;
		const loadedFrom = toChartTime(candles[0].time);
		const loadedTo = toChartTime(candles[candles.length - 1].time);

		if (
			!Number.isFinite(requestedFrom)
			|| !Number.isFinite(requestedTo)
			|| !Number.isFinite(duration)
			|| duration <= 0
			|| !Number.isFinite(loadedFrom)
			|| !Number.isFinite(loadedTo)
			|| !this.chart.timeScale().setVisibleRange
		) {
			return false;
		}

		let from = requestedFrom;
		let to = requestedTo;

		if (to > loadedTo) {
			to = loadedTo;
			from = to - duration;
		}

		if (from < loadedFrom) {
			from = loadedFrom;
			to = Math.min(loadedTo, from + duration);
		}

		this.chart.timeScale().setVisibleRange({ from, to });

		return true;
	};

	getLoadedCandleGranularity = () => {
		if (this.state.loadedPeriodGranularity) {
			return Number(this.state.loadedPeriodGranularity);
		}

		return Number(this.state.loadedPeriodDays) <= DEFAULT_PERIOD_DAYS ? 3600 : 21600;
	};

	findCandleIndexByTime = (candles, time) => {
		const targetTime = Number(time);

		if (!Array.isArray(candles) || !Number.isFinite(targetTime)) return -1;

		let low = 0;
		let high = candles.length - 1;

		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const candleTime = Number(candles[middle].time);

			if (candleTime === targetTime) return middle;
			if (candleTime < targetTime) low = middle + 1;
			else high = middle - 1;
		}

		return -1;
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

	fetchOfficialRecentCandles = (endTime, limit = 3) => {
		const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).trim().toUpperCase();
		const granularity = this.getLoadedCandleGranularity();

		if (!baseCurrency || !Number.isFinite(Number(endTime))) {
			return Promise.resolve([]);
		}

		return api.getCandles({
			product_id: `${baseCurrency}-USD`,
			days: Number(this.state.loadedPeriodDays) || DEFAULT_PERIOD_DAYS,
			granularity,
			end_time: Math.max(0, Math.floor(Number(endTime))),
			limit: Math.max(1, Math.min(300, limit)),
			_: Date.now(),
		}).then(response => this.parseCandlesResponse(response.data).candles)
			.catch(() => []);
	};

	mergeOfficialIntoHistorical = (historicalCandles, officialCandles, beforeTime) => {
		const byTime = new Map();

		(Array.isArray(historicalCandles) ? historicalCandles : []).forEach(candle => {
			byTime.set(Number(candle.time), candle);
		});

		(Array.isArray(officialCandles) ? officialCandles : []).forEach(candle => {
			const time = Number(candle.time);

			if (Number.isFinite(time) && time < beforeTime) {
				byTime.set(time, candle);
			}
		});

		return [...byTime.values()].sort((left, right) => Number(left.time) - Number(right.time));
	};

	finalizeBucketRolls = (historicalCandles, rolls) => {
		if (!Array.isArray(rolls) || !rolls.length) {
			return Promise.resolve(historicalCandles);
		}

		const rollRequestId = ++this.candleRollRequestId;
		const newestOpenBucket = Number(rolls[rolls.length - 1].openBucketTime);
		const endTime = newestOpenBucket - 1;

		return this.fetchOfficialRecentCandles(endTime, rolls.length + 5).then(officialCandles => {
			if (rollRequestId !== this.candleRollRequestId) {
				return historicalCandles;
			}

			return this.mergeOfficialIntoHistorical(
				historicalCandles,
				officialCandles,
				newestOpenBucket,
			);
		});
	};

	mergeTradeIntoCurrentCandle = (currentCandle, trade) => {
		const price = Number(trade.price);
		const size = Number(trade.size) || 0;
		const source = String(trade.source || "");
		const isTickerUpdate = source === "ticker" || source === "ticker_batch";

		return {
			...currentCandle,
			high: Math.max(currentCandle.high, price),
			low: Math.min(currentCandle.low, price),
			close: price,
			volume: isTickerUpdate
				? currentCandle.volume
				: (currentCandle.volume || 0) + size,
		};
	};

	createCurrentCandleFromTrade = (trade, priorClose) => {
		const price = Number(trade.price);
		const size = Number(trade.size) || 0;
		const time = Number(trade.time);
		const source = String(trade.source || "");
		const isTickerUpdate = source === "ticker" || source === "ticker_batch";
		const openPrice = isTickerUpdate
			? (Number.isFinite(Number(priorClose)) ? Number(priorClose) : price)
			: price;

		return {
			time,
			open: openPrice,
			high: Math.max(openPrice, price),
			low: Math.min(openPrice, price),
			close: price,
			volume: isTickerUpdate ? 0 : size,
		};
	};

	processLiveTradeBatch = (historicalCandles, currentCandle, trades) => {
		let current = currentCandle ? { ...currentCandle } : null;
		const rolls = [];
		let changed = false;
		let didStartNewCandle = false;
		let latestCandleTime = null;
		let latestPrice = null;

		trades.forEach(trade => {
			const price = Number(trade.price);
			const time = Number(trade.time);
			const source = String(trade.source || "");
			const isTickerUpdate = source === "ticker" || source === "ticker_batch";

			if (!Number.isFinite(price) || !Number.isFinite(time)) return;

			latestPrice = price;

			if (!current) {
				if (isTickerUpdate) return;

				current = this.createCurrentCandleFromTrade(trade, null);
				changed = true;
				latestCandleTime = time;
				return;
			}

			if (time < current.time) return;

			if (time === current.time) {
				current = this.mergeTradeIntoCurrentCandle(current, trade);
				changed = true;
				latestCandleTime = time;
				return;
			}

			rolls.push({
				closedBucketTime: current.time,
				openBucketTime: time,
			});
			didStartNewCandle = true;
			changed = true;
			latestCandleTime = time;
			current = this.createCurrentCandleFromTrade(trade, current.close);
		});

		return {
			historicalCandles,
			currentCandle: current,
			rolls,
			changed,
			didStartNewCandle,
			latestCandleTime,
			latestPrice,
		};
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
		const bids = this.mergeDepthLevels(prev.depth.bids, depthMessage.depth.bids.filter(isInRange));
		const asks = this.mergeDepthLevels(prev.depth.asks, depthMessage.depth.asks.filter(isInRange));

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

	updateCurrentCandleOnChart = (currentCandle, highlightedIndex = this.state.hoveredVolumeIndex) => {
		if (!currentCandle || !this.candleSeries) return;

		this.candleSeries.update(toChartPoint(currentCandle));

		if (!this.volumeSeries) return;

		this.volumeSeries.update({
			time: toChartTime(currentCandle.time),
			value: this.getCandleVolumeUsd(currentCandle),
			color: this.getVolumeBarColor(
				currentCandle,
				highlightedIndex === this.state.candles.length - 1,
			),
		});
	};

	syncCandleSeries = (candles = this.state.candles) => {
		if (!Array.isArray(candles) || !candles.length) return;

		this.candleSeries?.setData(toChartData(candles));
		this.syncVolumeSeries(candles);
	};

	loadOlderCandles = () => {
		if (
			this.isMarketTransitioning
			|| this.state.isLoading
			|| this.state.isLoadingOlderCandles
			|| !this.state.hasMoreOlderCandles
			|| !this.state.candles.length
		) {
			return;
		}

		const oldestCandle = this.state.historicalCandles[0] || this.state.candles[0];
		const oldestTime = Number(oldestCandle?.time);
		const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).trim().toUpperCase();
		const granularity = this.getLoadedCandleGranularity();
		const requestId = this.marketRequestId;

		if (!baseCurrency || !Number.isFinite(oldestTime) || !Number.isFinite(granularity)) return;

		this.setState({ isLoadingOlderCandles: true });

		api.getCandles({
			product_id: `${baseCurrency}-USD`,
			days: Number(this.state.loadedPeriodDays) || DEFAULT_PERIOD_DAYS,
			granularity,
			end_time: Math.max(0, oldestTime - 1),
			limit: 300,
			_: Date.now(),
		}).then(response => {
			if (requestId !== this.marketRequestId || baseCurrency !== this.state.loadedBaseCurrency) return;

			const olderCandles = this.parseCandlesResponse(response.data).candles
				.filter(candle => Number(candle.time) < oldestTime);

			if (!olderCandles.length) {
				this.setState({
					isLoadingOlderCandles: false,
					hasMoreOlderCandles: false,
				});
				return;
			}

			const candlesByTime = new Map();

			[...olderCandles, ...this.state.historicalCandles].forEach(candle => {
				candlesByTime.set(Number(candle.time), candle);
			});

			const historicalCandles = [...candlesByTime.values()]
				.sort((a, b) => Number(a.time) - Number(b.time));

			this.setCandleData(historicalCandles, this.state.currentCandle, null, () => {
				this.syncCandleSeries(this.state.candles);
				this.syncVwapSeries(this.state.candles);
				this.syncTdSequentialSeries(this.state.tdSequential, this.state.candles);

				window.requestAnimationFrame(() => {
					this.setState({
						isLoadingOlderCandles: false,
					}, () => {
						this.scheduleOverlayUpdate();

						const nextRange = this.chart?.timeScale().getVisibleLogicalRange?.();

						if (nextRange && Number.isFinite(nextRange.from) && nextRange.from < 24) {
							window.setTimeout(this.loadOlderCandles, 0);
						}
					});
				});
			});
		}).catch(() => {
			if (requestId !== this.marketRequestId) return;

			this.setState({
				isLoadingOlderCandles: false,
				hasMoreOlderCandles: false,
			});
		});
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

	getCandlesForDefaultViewport = (candles) => {
		if (!Array.isArray(candles) || !candles.length) return candles;

		const periodDays = Number(this.state.loadedPeriodDays || this.state.periodDays) || DEFAULT_PERIOD_DAYS;
		const loadedTo = Number(candles[candles.length - 1].time);

		if (!Number.isFinite(loadedTo)) return candles;

		const fromTime = loadedTo - periodDays * 24 * 3600;

		return candles.filter(candle => Number(candle.time) >= fromTime);
	};

	getDepthRangeForCandles = (candles) => {
		if (!Array.isArray(candles) || !candles.length) {
			return null;
		}

		const chartMin = Math.min(...candles.map(candle => candle.low));
		const chartMax = Math.max(...candles.map(candle => candle.high));
		const minSpan = Math.max(Math.abs(chartMax) * 0.005, 0.01);
		const span = Math.max(chartMax - chartMin, minSpan);
		const padding = span * DEPTH_CHART_PADDING_RATIO;

		return {
			min_price: chartMin - padding,
			max_price: chartMax + padding,
		};
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

	getPinnedMarketDepthRange = () => this.pinnedMarketDepthRange;

	mergeDepthLevels = (previousLevels, nextLevels) => {
		const merged = new Map();

		(Array.isArray(previousLevels) ? previousLevels : []).forEach(level => {
			const price = Number(level?.price);

			if (Number.isFinite(price)) {
				merged.set(price, level);
			}
		});

		(Array.isArray(nextLevels) ? nextLevels : []).forEach(level => {
			const price = Number(level?.price);
			const size = Number(level?.size);

			if (!Number.isFinite(price)) return;

			if (!Number.isFinite(size) || size <= 0) {
				merged.delete(price);
				return;
			}

			merged.set(price, level);
		});

		return Array.from(merged.values());
	};

	applyDefaultVisibleRange = (candles = this.state.candles) => {
		if (!this.chart || !Array.isArray(candles) || !candles.length) return false;

		const logicalRange = this.getDefaultViewportLogicalRange(candles);

		if (!logicalRange || !this.chart.timeScale().setVisibleLogicalRange) return false;

		this.getMainPriceScale()?.applyOptions({ autoScale: true });
		this.chart.timeScale().applyOptions({ rightOffset: 0 });
		this.chart.timeScale().setVisibleLogicalRange(logicalRange);
		this.scheduleOverlayUpdate();

		requestAnimationFrame(() => {
			if (!this.chart) return;

			this.getMainPriceScale()?.applyOptions({ autoScale: true });
			this.scheduleOverlayUpdate();
		});

		return true;
	};

	refitViewport = () => {
		if (this.applyDefaultVisibleRange()) return;

		if (!this.chart) return;

		this.chart.priceScale('right').applyOptions({ autoScale: true });
		this.chart.timeScale().fitContent();
		this.scheduleOverlayUpdate();
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

	getBalanceBookmarkDelta = (balance) => {
		const currency = String(balance?.currency || "").trim().toUpperCase();

		if (!currency || currency === "USD" || currency === "USDC") return null;

		const bookmarkedPrice = this.getBookmarkedPriceForCurrency(currency);
		const currentPrice = Number(balance?.usd_price);
		const balanceAmount = Number(balance?.total);

		if (
			!Number.isFinite(bookmarkedPrice) ||
			bookmarkedPrice <= 0 ||
			!Number.isFinite(currentPrice) ||
			!Number.isFinite(balanceAmount) ||
			balanceAmount <= 0
		) {
			return null;
		}

		const deltaPerUnit = currentPrice - bookmarkedPrice;
		const deltaUsd = deltaPerUnit * balanceAmount;
		const deltaPercent = (deltaPerUnit / bookmarkedPrice) * 100;

		if (!Number.isFinite(deltaUsd) || !Number.isFinite(deltaPercent)) return null;

		return {
			isPositive: deltaUsd >= 0,
			label: `${formatSignedUsdCents(deltaUsd)} (${formatSignedPercent(deltaPercent)})`,
		};
	};

	applyAppState = (appState) => {
		const bookmarks = appState?.yzTrade?.bookmarks;
		const appBookmarks = bookmarks && typeof bookmarks === "object" && !Array.isArray(bookmarks)
			? Object.fromEntries(
				Object.entries(bookmarks)
					.map(([currency, price]) => [String(currency || "").toUpperCase(), normalizeBookmarkPrice(price)])
					.filter(([currency, price]) => currency && price !== null)
			)
			: {};
		const currency = this.state.loadedBaseCurrency || this.state.baseCurrency;
		const bookmarkedPrice = this.getBookmarkedPriceForCurrency(currency);
		const settings = appState?.yzTrade?.settings;
		const balanceHistoryPeriod = normalizeBalanceHistoryPeriod(
			settings?.balanceHistoryPeriod,
			this.state.balanceHistoryPeriod,
		);
		const periodChanged = balanceHistoryPeriod !== this.state.balanceHistoryPeriod;
		const appSettings = settings && typeof settings === "object" && !Array.isArray(settings)
			? {
				balanceHistoryExpanded: Boolean(settings.balanceHistoryExpanded),
				balanceHistoryPeriod,
			}
			: this.state.appSettings;

		this.setState({
			appBookmarks,
			appSettings,
			bookmarkedPrice,
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
			this.setState({ appBookmarks: null });
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

			this.applyAppState(message.state);
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

		if (this.liveReconnectTimer) {
			window.clearTimeout(this.liveReconnectTimer);
			this.liveReconnectTimer = null;
		}

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

	getLiveLogTimestamp = () => new Date().toISOString();

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

			console.warn("[live] market watchdog stale; closing socket to reconnect", {
				timestamp: this.getLiveLogTimestamp(),
				productId: this.liveProductId,
				elapsed,
				timeout: LIVE_STALE_TIMEOUT_MS,
			});
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

		console.warn("[live] reconnect scheduled", {
			timestamp: this.getLiveLogTimestamp(),
			productId: this.liveReconnectConfig?.productId,
			attempt: this.liveReconnectAttempt + 1,
			delay,
		});
		this.liveReconnectAttempt += 1;
		this.liveReconnectTimer = window.setTimeout(() => {
			const config = this.liveReconnectConfig;

			this.liveReconnectTimer = null;

			if (!config) return;

			console.warn("[live] reconnecting", {
				timestamp: this.getLiveLogTimestamp(),
				productId: config.productId,
				attempt: this.liveReconnectAttempt,
			});
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

			console.warn("[live] connect timeout; closing socket to reconnect", {
				timestamp: this.getLiveLogTimestamp(),
				productId,
				readyState: socket.readyState,
			});
			socket.close();
		}, LIVE_CONNECT_TIMEOUT_MS);

		socket.onopen = () => {
			if (socket === this.liveSocket) {
				if (this.liveConnectTimeout) {
					window.clearTimeout(this.liveConnectTimeout);
					this.liveConnectTimeout = null;
				}

				console.info("[live] socket open", {
					timestamp: this.getLiveLogTimestamp(),
					productId,
				});
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
					console.info("[live] market subscribed", {
						timestamp: this.getLiveLogTimestamp(),
						productId: message.product_id,
					});
					this.markLiveConnected();
				} else if (message.stream === "orders") {
					console.info("[live] orders subscribed", {
						timestamp: this.getLiveLogTimestamp(),
						productId: message.product_id,
					});
					this.setState({ orderError: "" });
				} else if (message.stream === "depth") {
					console.info("[live] depth subscribed", {
						timestamp: this.getLiveLogTimestamp(),
						productId: message.product_id,
					});
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
				console.error("[live] backend stream error", {
					timestamp: message.timestamp || this.getLiveLogTimestamp(),
					productId: message.product_id,
					stream: message.stream,
					message: message.message,
					reconnectIn: message.reconnect_in,
				});
				this.setState({ isLive: false });
			}
		};

		socket.onerror = () => {
			if (socket !== this.liveSocket) return;

			console.error("[live] socket error", {
				timestamp: this.getLiveLogTimestamp(),
				productId,
			});
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

			console.warn("[live] socket closed", {
				timestamp: this.getLiveLogTimestamp(),
				productId,
			});
			this.clearLiveWatchdog();
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
			const bids = this.mergeDepthLevels(prev.depth.bids, depth.bids.filter(isInRange));
			const asks = this.mergeDepthLevels(prev.depth.asks, depth.asks.filter(isInRange));

			if (!bids.length && !asks.length) return null;

			let currentCandle = prev.currentCandle;

			if (currentCandle && Number.isFinite(currentPrice)) {
				currentCandle = {
					...currentCandle,
					high: Math.max(currentCandle.high, currentPrice),
					low: Math.min(currentCandle.low, currentPrice),
					close: currentPrice,
				};
			}

			return {
				currentCandle,
				candles: this.buildDisplayCandles(prev.historicalCandles, currentCandle),
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
			if (this.state.currentCandle) {
				this.updateCurrentCandleOnChart(this.state.currentCandle);
				this.syncVwapSeries(this.state.candles);
			}

			this.scheduleOverlayUpdate();
		});
	};

	applyLiveOrders = (message) => {
		const updatedOrders = Array.isArray(message.orders) ? message.orders : [];
		const removedOrderIds = new Set(Array.isArray(message.removed_order_ids) ? message.removed_order_ids : []);
		const shouldRefreshProfile = removedOrderIds.size > 0;

		this.setState(prev => {
			return {
				orders: this.mergeOrderUpdates(prev.orders, updatedOrders, removedOrderIds),
				allOrders: this.mergeOrderUpdates(prev.allOrders, updatedOrders, removedOrderIds),
				orderError: "",
				allOrdersError: "",
			};
		}, () => {
			this.scheduleOverlayUpdate();

			if (shouldRefreshProfile) {
				this.refreshProfileAfterOrderChange();
			}
		});
	};

	mergeOrderUpdates = (orders, updatedOrders, removedOrderIds) => {
		const ordersById = new Map();

		(Array.isArray(orders) ? orders : []).forEach(order => {
			if (
				order?.id
				&& !isRemovedLiveOrder(order, removedOrderIds)
				&& isOpenOrderStatus(order.status)
			) {
				ordersById.set(order.id, enrichOrderForDisplay(order));
			}
		});

		updatedOrders.forEach(order => {
			if (!order?.id) return;

			if (!isOpenOrderStatus(order.status) || isRemovedLiveOrder(order, removedOrderIds)) {
				ordersById.delete(order.id);
				return;
			}

			const existing = ordersById.get(order.id);
			ordersById.set(order.id, mergeOrderFields(existing, order));
		});

		return Array.from(ordersById.values());
	};

	applyLiveTrade = (trade, depthMessage = null) => {
		this.applyLiveTrades([trade], depthMessage);
	};

	applyLiveTrades = (trades, depthMessage = null) => {
		if (!Array.isArray(trades) || !trades.length) return;

		const sortedTrades = [...trades].sort((left, right) => Number(left.time) - Number(right.time));
		const processed = this.processLiveTradeBatch(
			this.state.historicalCandles,
			this.state.currentCandle,
			sortedTrades,
		);
		const depth = this.buildDepthStateFromMessage(this.state, depthMessage, processed.latestPrice);
		const depthChanged = depth !== this.state.depth;

		if (!processed.changed && !depthChanged) return;

		const finishUpdate = (historicalCandles, currentCandle, didStartNewCandle, latestCandleTime, chartChanged) => {
			const depthState = depthChanged
				? {
					depth: {
						...depth,
						current_price: Number.isFinite(processed.latestPrice)
							? processed.latestPrice
							: depth.current_price,
					},
				}
				: null;

			this.setCandleData(historicalCandles, currentCandle, depthState, () => {
				if (currentCandle && chartChanged) {
					if (didStartNewCandle) {
						this.syncCandleSeries(this.state.candles);
					} else {
						this.updateCurrentCandleOnChart(currentCandle);
					}

					this.syncVwapSeries(this.state.candles);

					if (didStartNewCandle) {
						this.refreshTdSequentialAfterClosedCandle(latestCandleTime);
					}
				} else if (depthChanged) {
					this.syncVwapSeries(this.state.candles);
				}

				this.scheduleOverlayUpdate();
			});
		};

		if (!processed.rolls.length) {
			finishUpdate(
				processed.historicalCandles,
				processed.currentCandle,
				false,
				processed.latestCandleTime,
				processed.changed,
			);
			return;
		}

		this.finalizeBucketRolls(processed.historicalCandles, processed.rolls).then(historicalCandles => {
			finishUpdate(
				historicalCandles,
				processed.currentCandle,
				processed.didStartNewCandle,
				processed.latestCandleTime,
				true,
			);
		});
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
		const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).trim().toUpperCase();
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
		this.candleRollRequestId += 1;
		this.isMarketTransitioning = true;
		const rangeSnapshot = this.getVisibleRangeSnapshot();
		const shouldPreserveRange =
			baseCurrency === this.state.loadedBaseCurrency
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
			orders: [],
			hoveredVolumeIndex: null,
			freeCrosshairX: null,
			pointerPosition: null,
			bookmarkedPrice: this.getBookmarkedPriceForCurrency(baseCurrency),
		});
		this.disconnectLiveMarket();
		this.pinnedMarketDepthRange = null;
		this.candleSeries?.setData([]);
		this.volumeSeries?.setData([]);
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

				const { candles: normalizedCandles, priceRange } = this.parseCandlesResponse(
					candlesResponse.data,
				);

				if (!normalizedCandles.length) {
					throw new Error(`Coinbase returned no candle data for ${productId}.`);
				}

				const { historicalCandles, currentCandle } = this.splitCandlesFromApi(normalizedCandles);
				const loadedMarketCandles = this.buildDisplayCandles(historicalCandles, currentCandle);
				this.pinnedMarketDepthRange = priceRange;
				const depthRange = this.pinnedMarketDepthRange;
				const candles = loadedMarketCandles;

				this.setState({
					candles,
					historicalCandles,
					currentCandle,
					baseCurrency,
					periodDays,
					periodGranularity,
					loadedBaseCurrency: baseCurrency,
					loadedPeriodDays: periodDays,
					loadedPeriodGranularity: periodGranularity,
					isLoading: false,
					bookmarkedPrice: this.getBookmarkedPriceForCurrency(baseCurrency),
				}, () => {
					if (requestId !== this.marketRequestId) return;

					if (!shouldPreserveRange) {
						this.getMainPriceScale()?.applyOptions({ autoScale: true });
					}

					this.candleSeries.setData(toChartData(candles));
					this.applyPriceSeriesFormat();
					this.syncVolumeSeries(candles);
					this.syncVwapSeries(candles);
					this.syncTdSequentialSeries(null, candles);
					this.handleResize();

					const didRestoreView = shouldPreserveRange
						? this.restoreVisibleRange(rangeSnapshot)
						: this.restoreVisibleTimeframeByDates(rangeSnapshot, candles);

					if (!didRestoreView) {
						this.applyDefaultVisibleRange(candles);
					}

					this.syncCurrencyPath(baseCurrency);
					this.loadProductStats(productId);
					this.connectLiveMarket(productId, periodDays, periodGranularity, depthRange);
					this.isMarketTransitioning = false;
					this.scheduleOverlayUpdate();
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
					orders: [],
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
			_: Date.now(),
		}).then(ordersResponse => {
			if (requestId !== this.marketRequestId) return;

			this.setState({
				orders: Array.isArray(ordersResponse.data?.orders) ? ordersResponse.data.orders : [],
				orderStats: {
					openTotal: ordersResponse.data?.open_total,
					applicableTotal: ordersResponse.data?.applicable_total,
					drawableTotal: ordersResponse.data?.drawable_total,
					skippedTotal: ordersResponse.data?.skipped_total,
				},
				orderError: "",
			}, this.scheduleOverlayUpdate);
		}).catch(error => {
			if (requestId !== this.marketRequestId) return;

			this.setState({
				orders: [],
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
		this.loadMarket();
		this.loadProfile();
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
		const loadedBaseCurrency = String(this.state.loadedBaseCurrency || "").trim().toUpperCase();
		const activeProductId = productId || (loadedBaseCurrency ? `${loadedBaseCurrency}-USD` : "");

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

	loadProfile = () => {
		const requestId = ++this.profileRequestId;

		this.setState({
			isProfileLoading: !this.state.profile,
			profileError: "",
		});

		return api.getBalances().then(response => {
			if (requestId !== this.profileRequestId) return null;

			const profile = response.data;

			this.setState({
				profile,
				profileError: "",
				isProfileLoading: false,
			});

			return profile;
		}).catch(error => {
			if (requestId !== this.profileRequestId) return null;

			this.setState({
				profileError: error.response?.data?.detail || error.message || "Unable to load Coinbase balances.",
				isProfileLoading: false,
			});

			return null;
		});
	};

	refreshProfileAfterOrderChange = () => {
		this.profileRefreshAfterOrderTimers.forEach(timer => window.clearTimeout(timer));
		this.profileRefreshAfterOrderTimers = [0, 1500, 4000].map(delay => (
			window.setTimeout(() => {
				this.loadProfile();
				this.loadAllOrders();
			}, delay)
		));
	};

	loadOrders = () => {
		const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).trim().toUpperCase();
		const productId = `${baseCurrency}-USD`;

		if (!baseCurrency) return Promise.resolve();

		return api.getOrders({
			product_id: productId,
			_: Date.now(),
		}).then(response => {
			const orders = Array.isArray(response.data?.orders)
				? response.data.orders.map(enrichOrderForDisplay)
				: [];

			this.setState({
				orders,
				orderStats: {
					openTotal: response.data?.open_total,
					applicableTotal: response.data?.applicable_total,
					drawableTotal: response.data?.drawable_total,
					skippedTotal: response.data?.skipped_total,
				},
				orderError: "",
			});
		}).catch(error => {
			this.setState({
				orderError: error.response?.data?.detail || error.message || "Unable to load Coinbase orders.",
			});
		});
	};

	loadAllOrders = () => {
		const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).trim().toUpperCase();
		const productId = `${baseCurrency}-USD`;

		this.setState({
			isOrdersLoading: !this.state.allOrders.length,
			allOrdersError: "",
		});

		return api.getOrders({
			product_id: productId,
			all_products: true,
			_: Date.now(),
		}).then(response => {
			const allOrders = Array.isArray(response.data?.orders)
				? response.data.orders.map(enrichOrderForDisplay)
				: [];
			const chartOrders = filterOrdersForChartProduct(allOrders, productId);

			this.setState({
				allOrders,
				orders: chartOrders,
				orderStats: {
					openTotal: response.data?.open_total,
					applicableTotal: chartOrders.length,
					drawableTotal: chartOrders.length,
					skippedTotal: response.data?.skipped_total,
				},
				allOrdersError: "",
				orderError: "",
				isOrdersLoading: false,
			}, this.scheduleOverlayUpdate);
		}).catch(error => {
			this.setState({
				allOrdersError: error.response?.data?.detail || error.message || "Unable to load Coinbase orders.",
				isOrdersLoading: false,
			});
		});
	};

	forceRefreshAccount = () => {
		if (this.state.isAccountRefreshing) return;

		this.setState({ isAccountRefreshing: true });

		Promise.allSettled([
			this.loadOrders(),
			this.loadAllOrders(),
			this.loadProfile(),
		]).finally(() => {
			this.setState({ isAccountRefreshing: false });
		});
	};

	handleProfileCurrencyClick = (currency) => {
		const baseCurrency = String(currency || "").trim().toUpperCase();

		if (!baseCurrency || baseCurrency === "USD" || baseCurrency === "USDC") return;

		this.setState({
			baseCurrency,
			isProfileOpen: false,
			isOrdersOpen: false,
		}, this.loadMarket);
	};

	handleOrdersCurrencyClick = (currency) => {
		const baseCurrency = String(currency || "").trim().toUpperCase();

		if (!baseCurrency || baseCurrency === "USD" || baseCurrency === "USDC" || baseCurrency === "UNKNOWN") return;

		this.setState({
			baseCurrency,
			isProfileOpen: false,
			isOrdersOpen: false,
		}, this.loadMarket);
	};

	getAvailableBalanceForSide = (side = this.state.orderTicket?.side, profile = this.state.profile) => {
		const balances = Array.isArray(profile?.balances) ? profile.balances : [];
		const normalizedSide = side === "SELL" ? "SELL" : "BUY";

		if (normalizedSide === "SELL") {
			const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).toUpperCase();
			const balance = balances.find(item => item.currency === baseCurrency);

			return {
				currency: baseCurrency,
				amount: Number(balance?.available) || 0,
			};
		}

		const quote = this.getBuyQuoteBalance(0, profile);

		return {
			currency: quote.currency,
			amount: quote.amount,
		};
	};

	getDisplayedBalanceForSide = (side = this.state.orderTicket?.side) => {
		const balances = Array.isArray(this.state.profile?.balances) ? this.state.profile.balances : [];
		const normalizedSide = side === "SELL" ? "SELL" : "BUY";

		if (normalizedSide === "SELL") {
			const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).toUpperCase();
			const balance = balances.find(item => item.currency === baseCurrency);
			const available = Number(balance?.available);

			return {
				currency: baseCurrency,
				amount: Number.isFinite(available) ? available : 0,
			};
		}

		const usd = balances.find(item => item.currency === "USD");
		const usdc = balances.find(item => item.currency === "USDC");
		const usdAvailable = Number(usd?.available) || 0;
		const usdcAvailable = Number(usdc?.available) || 0;
		const useUsdc = usdcAvailable >= usdAvailable;

		return {
			currency: useUsdc ? "USDC" : "USD",
			amount: useUsdc ? usdcAvailable : usdAvailable,
		};
	};

	getBuyQuoteBalance = (requiredAmount = 0, profile = this.state.profile) => {
		const balances = Array.isArray(profile?.balances) ? profile.balances : [];
		const usd = balances.find(item => item.currency === "USD");
		const usdc = balances.find(item => item.currency === "USDC");
		const options = [
			{ currency: "USD", amount: Number(usd?.available) || 0 },
			{ currency: "USDC", amount: Number(usdc?.available) || 0 },
		];
		const required = Number(requiredAmount);
		const coveringOption = options.find(item => Number.isFinite(required) && required > 0 && item.amount >= required);

		return coveringOption || options.sort((a, b) => b.amount - a.amount)[0];
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
		const normalizedType = String(orderType || "LIMIT").toUpperCase();
		const allowedTypes = normalizedSide === "SELL"
			? ["LIMIT", "MARKET", "STOP_LIMIT", "BRACKET"]
			: ["LIMIT", "MARKET", "STOP_LIMIT"];

		return allowedTypes.includes(normalizedType) ? normalizedType : "LIMIT";
	};

	getTicketPrimaryOrderType = (ticket) => {
		const orderType = this.normalizeOrderTypeForSide(ticket?.side, ticket?.orderType);

		return orderType === "STOP_LIMIT" || orderType === "BRACKET"
			? "STOP"
			: orderType;
	};

	getOrderTypeLabel = (orderType) => {
		switch (orderType) {
			case "MARKET":
				return "MARKET";
			case "STOP_LIMIT":
				return "STOP LIMIT";
			case "BRACKET":
				return "BRACKET";
			case "LIMIT":
			default:
				return "LIMIT";
		}
	};

	getDefaultAmountModeForSide = (side) => (
		side === "SELL" ? "BASE" : "USD"
	);

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
		const stopLossValue = Number.isFinite(numericPrice) ? this.getOrderPriceInputValue(numericPrice * 0.98) : "0";

		return {
			...saved,
			side: normalizedSide,
			orderType: "LIMIT",
			amountMode: this.getSavedAmountModeForSide(normalizedSide, saved),
			activePriceField: "price",
			anchorPrice: Number.isFinite(numericPrice) ? numericPrice : null,
			anchorOffsetY: ORDER_TICKET_ANCHOR_OFFSET_Y,
			anchorY: this.state.orderScaleHover?.y ?? this.state.chartSize.height / 2,
			price: priceValue,
			stopPrice: Number.isFinite(Number(saved.stopPrice)) ? this.getOrderPriceInputValue(saved.stopPrice) : priceValue,
			takeProfitPrice: Number.isFinite(Number(saved.takeProfitPrice)) ? this.getOrderPriceInputValue(saved.takeProfitPrice) : priceValue,
			stopLossPrice: Number.isFinite(Number(saved.stopLossPrice)) ? this.getOrderPriceInputValue(saved.stopLossPrice) : stopLossValue,
			amount: "0",
			fraction: 0,
			error: "",
			isSubmitting: false,
			preview: null,
			previewBodyKey: "",
			previewError: "",
			previewMarketPrice: null,
			isPreviewLoading: false,
		};
	};

	getSavedOrderSnapshot = (ticket) => (
		ticket
			? {
				side: ticket.side,
				orderType: ticket.orderType,
				amountMode: ticket.amountMode,
				price: ticket.price,
				stopPrice: ticket.stopPrice,
				takeProfitPrice: ticket.takeProfitPrice,
				stopLossPrice: ticket.stopLossPrice,
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
		const stopLossValue = Number.isFinite(numericPrice) ? this.getOrderPriceInputValue(numericPrice * 0.98) : "0";
		const nextOrderType = this.normalizeOrderTypeForSide(normalizedSide, saved.orderType);
		const amount = saved.amount ?? "0";
		const ticket = {
			...saved,
			side: normalizedSide,
			orderType: nextOrderType,
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
			takeProfitPrice: Number.isFinite(Number(saved.takeProfitPrice)) ? this.getOrderPriceInputValue(saved.takeProfitPrice) : priceValue,
			stopLossPrice: Number.isFinite(Number(saved.stopLossPrice)) ? this.getOrderPriceInputValue(saved.stopLossPrice) : stopLossValue,
			amount,
			error: "",
			isSubmitting: false,
			preview: null,
			previewBodyKey: "",
			previewError: "",
			previewMarketPrice: null,
			isPreviewLoading: false,
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

	openOrderTicket = (event) => {
		event.preventDefault();
		event.stopPropagation();

		if (this.state.isOrderTicketClosing || this.orderTicketCloseTimer) return;

		const hover = this.state.orderScaleHover;
		if (!hover) return;

		if (this.orderTicketCloseTimer) {
			window.clearTimeout(this.orderTicketCloseTimer);
			this.orderTicketCloseTimer = null;
		}

		const side = this.getDefaultOrderSideForPrice(hover.price);

		this.setState(prev => ({
			savedOrderTickets: this.clearSavedOrderTicketAmounts(prev.savedOrderTickets),
			orderTicket: this.getOrderTicketDefaults(hover.price, side),
			isOrderTicketClosing: false,
			lastOrderSide: side,
		}), () => {
			this.loadProfile();
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
				this.loadProfile();
				this.scheduleOrderPreview();
			});
			return;
		}

		const ticket = this.state.orderTicket;
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

		this.updateOrderPriceField(targetField, priceValue);
	};

	bookmarkOrderHoverPrice = (event) => {
		event.preventDefault();
		event.stopPropagation();

		const hover = this.state.orderScaleHover;
		if (!hover || !Number.isFinite(Number(hover.price))) return;

		const currency = this.state.loadedBaseCurrency || this.state.baseCurrency;
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
		event.preventDefault();
		event.stopPropagation();

		const currency = this.state.loadedBaseCurrency || this.state.baseCurrency;
		const normalizedCurrency = String(currency || "").toUpperCase();

		deleteBookmarkedPrice(currency);
		this.setState(prev => {
			const appBookmarks = prev.appBookmarks
				? { ...prev.appBookmarks }
				: prev.appBookmarks;

			if (appBookmarks) {
				delete appBookmarks[normalizedCurrency];
			}

			return {
				appBookmarks,
				bookmarkedPrice: null,
			};
		}, this.scheduleOverlayUpdate);

		api.deleteBookmark(currency)
			.catch(() => {
				this.loadAppState();
			});
	};

	prepareOrderTicketClose = () => {
		this.cancelOrderPreviewRequests();

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
			this.setState({
				orderTicket: null,
				isOrderTicketClosing: false,
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

	setOrderType = (orderType) => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		const normalizedOrderType = this.normalizeOrderTypeForSide(ticket.side, orderType);
		const currentOrderType = this.normalizeOrderTypeForSide(ticket.side, ticket.orderType);

		if (normalizedOrderType === currentOrderType) return;

		this.cancelOrderPreviewRequests();

		this.updateOrderTicket({
			...this.getOrderPreviewResetPatch(),
			orderType: normalizedOrderType,
		}, {
			onCommitted: () => {
				this.syncMarketPreviewPoller();
			},
		});
	};

	setSellStopOrderType = (orderType) => {
		this.setOrderType(orderType);
		this.setState({ isOrderTypeMenuOpen: false });
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

		const numericAmount = Number(ticket.amount);
		let nextAmount = ticket.amount;

		if (nextMax <= 0) {
			nextAmount = "0";
		} else if (Number.isFinite(numericAmount) && numericAmount > nextMax) {
			nextAmount = this.getOrderAmountInputValue(ticket, nextMax);
		}

		const nextFraction = this.getOrderFractionFromAmount(
			{ ...ticket, amount: nextAmount },
			nextAmount,
			nextMax,
		);
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

		if (orderType !== "MARKET" && Number.isFinite(price) && price > 0) {
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
			return ticket.amountMode === "USD"
				? availableAmount
				: referencePrice > 0
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

	updateOrderPriceField = (field, value) => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		const sanitizedValue = sanitizeNumericInput(value);
		const nextTicket = {
			...ticket,
			[field]: sanitizedValue,
		};

		this.updateOrderTicket({
			[field]: sanitizedValue,
			fraction: this.getOrderFractionFromAmount(nextTicket),
		});
	};

	getOverlayMarketPrice = (state = this.state) => {
		const overlayBaseCurrency = (
			state.isLoading
				? state.baseCurrency
				: state.loadedBaseCurrency || state.baseCurrency || state.defaultBaseCurrency
		).trim().toUpperCase();
		const isOverlayMarketLoaded = (
			overlayBaseCurrency === state.loadedBaseCurrency
			&& !state.isLoading
			&& Array.isArray(state.candles)
			&& state.candles.length > 0
		);

		if (!isOverlayMarketLoaded) {
			return NaN;
		}

		return Number(state.candles[state.candles.length - 1]?.close);
	};

	getLiveMarketPrice = () => this.getOverlayMarketPrice(this.state);

	getLiveMarketPriceFromState = (state = this.state) => this.getOverlayMarketPrice(state);

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

		if (!Number.isFinite(amount) || amount <= 0) {
			return {
				isValid: false,
				error: "",
			};
		}

		if (orderType !== "MARKET" && orderType !== "BRACKET" && (!Number.isFinite(price) || price <= 0)) {
			return {
				isValid: false,
				error: "Enter a valid limit price.",
			};
		}

		if (
			side === "BUY"
			&& orderType === "LIMIT"
			&& Number.isFinite(price)
			&& price > 0
		) {
			const currentPrice = this.getLiveMarketPrice();

			if (Number.isFinite(currentPrice) && price > currentPrice) {
				return {
					isValid: false,
					error: "Limit price cannot exceed current price.",
				};
			}
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
		}

		const sourceBalance = side === "BUY"
			? this.getBuyQuoteBalance(0)
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
		this.loadProfile().then(profile => {
			if (!this.state.orderTicket) return;

			this.setOrderFraction(fraction, {
				schedulePreview: true,
				profile: profile || this.state.profile,
			});
		});
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

		if (!Number.isFinite(amount) || amount <= 0) {
			return "";
		}

		if (orderType !== "MARKET" && orderType !== "BRACKET" && (!Number.isFinite(price) || price <= 0)) {
			return "Enter a valid limit price.";
		}

		if (
			side === "BUY"
			&& orderType === "LIMIT"
			&& Number.isFinite(price)
			&& price > 0
		) {
			const currentPrice = this.getLiveMarketPrice();

			if (Number.isFinite(currentPrice) && price > currentPrice) {
				return "Limit price cannot exceed current price.";
			}
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
		isPreviewLoading: false,
	});

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
				isPreviewLoading: false,
			}, { schedulePreview: false });
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
			isPreviewLoading: false,
		}, {
			schedulePreview: false,
			onCommitted: () => {
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
				isPreviewLoading: false,
			}, { schedulePreview: false });
			return;
		}

		const previewError = this.getOrderTicketPreviewError(ticket);

		if (previewError) {
			this.updateOrderTicket({
				preview: null,
				previewBodyKey: "",
				previewError: previewError === "" ? "" : previewError,
				previewMarketPrice: null,
				isPreviewLoading: false,
			}, { schedulePreview: false });
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
				isPreviewLoading: false,
			}, { schedulePreview: false });
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
			previewError: "",
		}, { schedulePreview: false });

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
					isPreviewLoading: false,
				}, { schedulePreview: false });
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
		const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).trim().toUpperCase();

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

		let quoteCurrency = side === "BUY" ? "USD" : "USDC";

		if (forPreview) {
			const previewError = this.getOrderTicketPreviewError(ticket);

			if (previewError) {
				return {
					body: null,
					error: previewError,
				};
			}

			if (side === "BUY") {
				quoteCurrency = this.getBuyQuoteBalance(0).currency || "USD";
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
				? validation.sourceCurrency || "USD"
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
		if (!ticket || ticket.isSubmitting || ticket.isPreviewLoading) return;

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

		if (!hasValidPreview) {
			this.refreshOrderPreview({ fromAmountChange: true });
			return;
		}

		this.updateOrderTicket({ isSubmitting: true, error: "" }, { schedulePreview: false });

		api.placeOrder({
			...body,
			preview_id: previewId,
			preview_base_size: preview?.base_size,
			preview_order_total: preview?.order_total,
			preview_commission_total: preview?.commission_total,
			preview_quote_size: preview?.quote_size,
		})
			.then((response) => {
				const optimisticOrder = buildOptimisticOrderFromPlacement({ body, preview, response });
				const closingTicket = this.state.orderTicket;

				this.prepareOrderTicketClose();

				this.setState(prev => {
					const ticket = prev.orderTicket;
					const nextState = {};

					if (optimisticOrder) {
						nextState.allOrders = this.mergeOrderUpdates(prev.allOrders, [optimisticOrder], new Set());
						nextState.orders = this.mergeOrderUpdates(prev.orders, [optimisticOrder], new Set());
					}

					if (!ticket) {
						return Object.keys(nextState).length ? nextState : null;
					}

					return {
						...nextState,
						isOrderTicketClosing: true,
						lastOrderSide: ticket.side === "SELL" ? "SELL" : "BUY",
						savedOrderTickets: {
							...prev.savedOrderTickets,
							[ticket.side]: this.getSavedOrderSnapshot(ticket),
						},
						orderScaleHover: null,
					};
				}, () => {
					if (closingTicket) {
						this.scheduleOrderTicketCloseEnd();
					}

					this.loadOrders();
					this.loadAllOrders();
					this.refreshProfileAfterOrderChange();
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

		const orderId = order?.cancel_id || order?.parent_id || order?.id;

		if (!orderId) {
			this.setState({ orderError: "Unable to cancel order: missing order id." });
			return;
		}

		const confirmed = window.confirm(`Cancel ${order.side} order at ${this.formatChartPrice(order.price)}?`);

		if (!confirmed) return;

		this.setState({ orderError: "" });

		api.cancelOrder(orderId).then(() => {
			this.loadOrders();
			this.loadAllOrders();
			this.refreshProfileAfterOrderChange();
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
			td: "showTdIndicator",
			vwap: "showVwapIndicator",
			histogram: "showHistogramIndicator",
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

	getPriceSeriesFormat = () => ({
		type: 'custom',
		minMove: Number(this.state.product?.quote_increment) || PRICE_MIN_MOVE,
		formatter: this.formatChartPrice,
	});

	applyPriceSeriesFormat = () => {
		const priceFormat = this.getPriceSeriesFormat();

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

	buildDistribution = () => {
		const { candles } = this.state;

		if (!candles.length) {
			return {
				bins: [],
				peaks: [],
				maxValue: 0,
			};
		}

		const minPrice = Math.min(...candles.map(candle => candle.low));
		const maxPrice = Math.max(...candles.map(candle => candle.high));
		const step = (maxPrice - minPrice) / DISTRIBUTION_BINS || 1;
		const bins = Array.from({ length: DISTRIBUTION_BINS }, (_, index) => ({
			price: minPrice + step * (index + 0.5),
			volumeValue: 0,
			countValue: 0,
		}));

		candles.forEach(candle => {
			const candleLow = Math.min(candle.low, candle.high);
			const candleHigh = Math.max(candle.low, candle.high);
			const startIndex = Math.max(
				0,
				Math.min(DISTRIBUTION_BINS - 1, Math.floor((candleLow - minPrice) / step))
			);
			const endIndex = Math.max(
				startIndex,
				Math.min(DISTRIBUTION_BINS - 1, Math.floor((candleHigh - minPrice) / step))
			);
			const touchedBins = endIndex - startIndex + 1;
			const volumeValuePerBin = (candle.volume || 1) / touchedBins;
			const countValuePerBin = 1 / touchedBins;

			for (let index = startIndex; index <= endIndex; index++) {
				bins[index].volumeValue += volumeValuePerBin;
				bins[index].countValue += countValuePerBin;
			}
		});

		const maxValue = Math.max(...bins.map(bin => bin.volumeValue), 0);
		const maxCountValue = Math.max(...bins.map(bin => bin.countValue), 0);
		const peaks = bins.filter((bin, index) => {
			const previous = bins[index - 1]?.volumeValue ?? -Infinity;
			const next = bins[index + 1]?.volumeValue ?? -Infinity;

			return maxValue > 0
				&& bin.volumeValue >= maxValue * PEAK_THRESHOLD
				&& bin.volumeValue >= previous
				&& bin.volumeValue >= next;
		});

		return { bins, peaks, maxValue, maxCountValue };
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

		applyBlockClamp(this.indicatorTogglesRef.current, "top");
		applyBlockClamp(this.scaleControlsRef.current, "bottom");

		const anchorPrice = Number(orderTicket?.anchorPrice);
		const anchorCoordinate = Number.isFinite(anchorPrice) ? this.priceToY(anchorPrice) : null;
		const anchorY = Number.isFinite(anchorCoordinate)
			? anchorCoordinate
			: Number.isFinite(Number(orderTicket?.anchorY))
				? Number(orderTicket.anchorY)
				: chartHeight / 2;
		const anchorOffsetY = Number.isFinite(Number(orderTicket?.anchorOffsetY))
			? Number(orderTicket.anchorOffsetY)
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

	getVisibleTimeRange = () => {
		if (!this.chart) return this.getLoadedTimeRange();

		const timeScale = this.chart.timeScale();
		const visibleTimeRange = timeScale.getVisibleRange?.();
		let range = null;

		if (
			visibleTimeRange
			&& Number.isFinite(Number(visibleTimeRange.from))
			&& Number.isFinite(Number(visibleTimeRange.to))
		) {
			const from = Number(visibleTimeRange.from);
			const to = Number(visibleTimeRange.to);

			if (from !== to) {
				range = {
					from: Math.min(from, to),
					to: Math.max(from, to),
				};
			}
		}

		if (!range) {
			const visibleLogicalRange = timeScale.getVisibleLogicalRange?.();

			if (visibleLogicalRange) {
				const from = this.logicalToTime(visibleLogicalRange.from);
				const to = this.logicalToTime(visibleLogicalRange.to);

				if (Number.isFinite(from) && Number.isFinite(to)) {
					range = {
						from: Math.min(from, to),
						to: Math.max(from, to),
					};
				}
			}
		}

		if (!range) return this.getLoadedTimeRange();

		const loadedRange = this.getLoadedTimeRange();

		if (!loadedRange) return range;

		const margin = 6 * 3600;

		return {
			from: Math.max(range.from, loadedRange.from - margin),
			to: Math.min(range.to, loadedRange.to + margin),
		};
	};

	getOrderPriceRange = () => {
		const { orders } = this.state;
		const orderPrices = (Array.isArray(orders) ? orders : [])
			.map(order => Number(order.price))
			.filter(Number.isFinite);

		if (!orderPrices.length) return null;

		return {
			minValue: Math.min(...orderPrices),
			maxValue: Math.max(...orderPrices),
		};
	};

	getAutoscaleInfo = (original) => {
		const base = original();
		const orderRange = this.getOrderPriceRange();

		if (!orderRange) return base;

		const priceRange = base?.priceRange
			? {
				minValue: Math.min(base.priceRange.minValue, orderRange.minValue),
				maxValue: Math.max(base.priceRange.maxValue, orderRange.maxValue),
			}
			: orderRange;

		return {
			priceRange,
			margins: base?.margins ?? {
				above: 12,
				below: 12,
			},
		};
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
		const productId = `${this.state.loadedBaseCurrency || this.state.baseCurrency}-USD`.toUpperCase();
		const statsProductId = String(productStats?.product_id || "").toUpperCase();
		const statsPercent = Number(productStats?.change_24h);
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

	getVwapSeriesOptions = () => ({
		color: '#28d7d7',
		lineWidth: 2,
		lineType: LineType.Curved,
		visible: this.state.showVwapIndicator,
		priceLineVisible: false,
		lastValueVisible: false,
		crosshairMarkerVisible: false,
		priceFormat: this.getPriceSeriesFormat(),
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
			this.vwapSeries[index].applyOptions({ visible: this.state.showVwapIndicator });
			this.vwapSeries[index].setData(toChartData(session.data));
		});
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

		const data = (Array.isArray(tdSequential?.candles) ? tdSequential.candles : [])
			.map(candle => ({
				time: Number(candle.time),
				value: Number(candle.close),
			}))
			.filter(point => Number.isFinite(point.time) && Number.isFinite(point.value))
			.filter(point => this.isTimeInLoadedRange(point.time, candles));

		this.tdSequentialSeries.setData(toChartData(data));
	};

	renderOverlay = () => {
		const {
			candles,
			depth,
			orders,
			tdSequential,
			chartSize,
			freeCrosshairX,
			pointerPosition,
			hoveredVolumeIndex,
			measurementStart,
			measurementEnd,
			orderTicket,
			overlayTick,
			showTdIndicator,
			showHistogramIndicator,
		} = this.state;

		void overlayTick;

		if (!candles.length || !chartSize.width || !chartSize.height) {
			return null;
		}

		const distribution = showHistogramIndicator
			? this.buildDistribution()
			: { bins: [], peaks: [], maxValue: 0, maxCountValue: 0 };
		const currentPrice = Number(candles[candles.length - 1].close);
		const currentY = this.priceToY(currentPrice);
		const currentX = this.timeToX(candles[candles.length - 1].time);
		const bids = Array.isArray(depth?.bids) ? depth.bids : [];
		const asks = Array.isArray(depth?.asks) ? depth.asks : [];
		const profileLeft = 12;
		const priceScaleWidth = Math.max(this.chart?.priceScale("right")?.width?.() || 0, 76);
		const priceScaleLeft = Math.max(120, chartSize.width - priceScaleWidth);
		const orderLabelOffset = 34;
		const orderCancelOffset = 16;
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
		const distributionPoints = buildDistributionPoints("volumeValue", distribution.maxValue);
		const countDistributionPoints = buildDistributionPoints("countValue", distribution.maxCountValue);
		const distributionLine = buildPolyline(distributionPoints);
		const countDistributionLine = buildPolyline(countDistributionPoints);
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
		const depthHoverLabel = depthHoverPoint ? getTrailLabelPosition(depthHoverPoint, depthHoverPoint.side === "ask" ? -14 : 18) : null;
		const orderLineRight = priceScaleLeft;
		const drawableOrders = (Array.isArray(orders) ? orders : [])
			.filter(order => isOpenOrderStatus(order.status))
			.flatMap(order => (
				Array.isArray(order.bracket_legs) && order.bracket_legs.length
					? order.bracket_legs.map(leg => ({
						...order,
						...leg,
						parent_id: order.id,
						order_type: order.order_type,
					}))
					: [order]
			));
		const orderLines = drawableOrders
			.map(order => {
				const price = Number(order.price);
				const y = this.priceToY(price);

				if (y === null || !Number.isFinite(price)) return null;

				return {
					...order,
					price,
					y,
					label: `${order.role === "take_profit" ? "TP " : order.role === "stop_loss" ? "SL " : ""}${this.formatOverlayPriceForProduct(price)} / ${formatOrderValue(order.total_value, order.amount, price, order.quote_size, order.order_total)}`,
				};
			})
			.filter(Boolean);
		const orderedLabelRows = [...orderLines]
			.sort((a, b) => a.y - b.y)
			.reduce((rows, order) => {
				const minGap = 16;
				const preferredY = Math.max(12, order.y - 5);
				const previousY = rows[rows.length - 1]?.labelY ?? -Infinity;

				rows.push({
					id: order.id,
					labelY: Math.min(
						chartSize.height - 8,
						Math.max(preferredY, previousY + minGap)
					),
				});

				return rows;
			}, []);
		const orderLabelYById = new Map(orderedLabelRows.map(row => [row.id, row.labelY]));
		const bookmarkedPriceValue = this.getBookmarkedPriceForCurrency(
			this.state.loadedBaseCurrency || this.state.baseCurrency
		);
		const bookmarkedCoordinate = bookmarkedPriceValue === null
			? null
			: this.priceToY(bookmarkedPriceValue);
		const bookmarkedY = (
			Number.isFinite(bookmarkedCoordinate)
			&& bookmarkedCoordinate >= 0
			&& bookmarkedCoordinate <= chartSize.height
		)
			? bookmarkedCoordinate
			: null;
		const bookmarkedLabelY = bookmarkedY === null
			? null
			: Math.min(chartSize.height - 8, Math.max(12, bookmarkedY - 5));
		const bookmarkedLineRight = priceScaleLeft;
		const orderTicketPriceValue = Number(orderTicket?.price);
		const orderTicketY = orderTicket && Number.isFinite(orderTicketPriceValue)
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
		const tdSequentialBadges = (showTdIndicator && Array.isArray(tdSequential?.setups) ? tdSequential.setups : [])
			.filter(setup => this.isTimeInLoadedRange(setup.time, candles))
			.map(setup => {
				const side = setup.side === "sell" ? "sell" : "buy";
				const time = Number(setup.time);
				const price = Number(setup.price);
				const count = Number(setup.count);
				const anchorCandle = this.getChartCandleAtOrBeforeTime(time, candles);
				const anchorTime = Number(anchorCandle?.time ?? time);
				const x = this.timeToX(anchorTime);
				const y = this.priceToY(price);
				const text = `${side === "sell" ? "S" : "B"}${count}`;
				const width = text.length > 2 ? 34 : 28;
				const height = 18;

				if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(count)) return null;
				if (x < -40 || x > chartSize.width + 40) return null;

				return {
					...setup,
					x,
					y,
					text,
					width,
					height,
					side,
				};
			})
			.filter(Boolean);
		const measurementPreview = measurementStart && !measurementEnd && pointerPosition
			? this.getMeasurementPointFromCoordinates(pointerPosition.x, pointerPosition.y)
			: null;
		const measurementTarget = measurementEnd || measurementPreview;
		const projectMeasurementPoint = (point) => {
			if (!point) return null;

			const x = this.chart?.timeScale().logicalToCoordinate?.(point.logical);
			const y = this.priceToY(point.price);

			return Number.isFinite(x) && Number.isFinite(y)
				? { ...point, x, y }
				: null;
		};
		const measurementA = projectMeasurementPoint(measurementStart);
		const measurementB = projectMeasurementPoint(measurementTarget);
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
				const duration = formatMeasurementDuration((measurement.end.time ?? 0) - (measurement.start.time ?? 0));
				const x = Math.min(
					chartSize.width - 10,
					Math.max(10, (measurement.start.x + measurement.end.x) / 2)
				);
				const y = Math.min(
					chartSize.height - 12,
					Math.max(18, measurement.rect.y - 8)
				);

				return {
					x,
					y,
					text: `${duration} / ${formatPrice(delta)} / ${formatSignedPercent(percent)}`,
					isPositive: delta >= 0,
				};
			})()
			: null;
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
				y: chartSize.height - 34,
				text: formatUsdValue(hoveredVolumeValue),
			}
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
							x={measurement.rect.x}
							y={measurement.rect.y}
							width={measurement.rect.width}
							height={measurement.rect.height}
						/>
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
							<text
								className={measurementLabel.isPositive ? "e__measurement-label--up" : "e__measurement-label--down"}
								x={measurementLabel.x}
								y={measurementLabel.y}
								textAnchor="middle"
							>
								{measurementLabel.text}
							</text>
						)}
					</g>
				)}

				<g className="e__distribution">
					{distributionLine && (
						<>
							<line
								className="e__distribution-axis"
								x1={profileLeft}
								x2={profileLeft}
								y1={0}
								y2={chartSize.height}
							/>
							<polyline className="e__distribution-line" points={distributionLine} />
							{countDistributionLine && (
								<polyline className="e__distribution-line e__distribution-line--count" points={countDistributionLine} />
							)}
						</>
					)}

					{distribution.peaks.map((peak, index) => {
						const point = distributionPoints.find(item => item.price === peak.price);
						if (!point) return null;

						return (
							<g key={`peak-${index}`}>
								<circle cx={point.x} cy={point.y} r={4} />
							</g>
						);
					})}
				</g>

				<g className="e__orders">
					{bookmarkedY !== null && (
						<g className="e__price-bookmark">
							<line x1={0} x2={bookmarkedLineRight} y1={bookmarkedY} y2={bookmarkedY} />
							<circle cx={bookmarkedLineRight} cy={bookmarkedY} r={3.5} />
							<text x={bookmarkedLineRight - orderLabelOffset} y={bookmarkedLabelY} textAnchor="end">
								{this.formatOverlayPriceForProduct(bookmarkedPriceValue)}
							</text>
							<g
								className="e__price-bookmark__delete"
								transform={`translate(${bookmarkedLineRight - orderCancelOffset}, ${bookmarkedLabelY - 4})`}
								role="button"
								tabIndex={0}
								onClick={this.clearBookmarkedPrice}
							>
								<circle r={7} />
								<path d="M -2.24 -2.24 L 2.24 2.24 M 2.24 -2.24 L -2.24 2.24" />
							</g>
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
										{this.formatOverlayPriceForProduct(orderTicketPriceValue)}
									</text>
								</g>
							)}
						</g>
					)}
					{orderLines.map(order => (
						<g
							key={order.id || `${order.side}-${order.price}-${order.amount}`}
							className={`e__order e__order--${order.side === "sell" ? "sell" : "buy"} ${order.role ? `e__order--${order.role.replace("_", "-")}` : ""}`}
						>
							<line x1={0} x2={orderLineRight} y1={order.y} y2={order.y} />
							<circle cx={orderLineRight} cy={order.y} r={3.5} />
							<text x={orderLineRight - orderLabelOffset} y={orderLabelYById.get(order.id) ?? Math.max(12, order.y - 5)} textAnchor="end">
								{order.label}
							</text>
							<g
								className="e__order-cancel"
								transform={`translate(${orderLineRight - orderCancelOffset}, ${(orderLabelYById.get(order.id) ?? Math.max(12, order.y - 5)) - 4})`}
								role="button"
								tabIndex={0}
								onClick={event => this.cancelOrder(order, event)}
							>
								<circle r={7} />
								<path d="M -2.24 -2.24 L 2.24 2.24 M 2.24 -2.24 L -2.24 2.24" />
							</g>
						</g>
					))}
				</g>

				<g className="e__td-sequential">
					{tdSequentialBadges.map(marker => (
						<g
							key={`${marker.side}-${marker.time}-${marker.count}`}
							className={`e__td-sequential__marker e__td-sequential__marker--${marker.side} ${marker.complete ? "e__td-sequential__marker--complete" : ""}`}
						>
							<rect
								x={marker.x - marker.width / 2}
								y={marker.y - marker.height / 2}
								width={marker.width}
								height={marker.height}
								rx={4}
							/>
							<text x={marker.x} y={marker.y + 4.5} textAnchor="middle">
								{marker.text}
							</text>
						</g>
					))}
				</g>

				{currentY !== null && currentX !== null && (
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
				background: { color: '#000105' },
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
				mode: this.state.isLogPriceScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
				invertScale: this.state.isInvertedPriceScale,
				minimumWidth: 76,
				scaleMargins: {
					top: 0.08,
					bottom: 0.24,
				},
			},
			timeScale: {
				timeVisible: true,
				secondsVisible: false,
				borderColor: '#111820',
				rightOffset: 0,
				...this.getTimeScaleBarSpacingOptions(el.clientWidth),
			},
			handleScroll: {
				mouseWheel: true,
				pressedMouseMove: true,
				horzTouchDrag: true,
				vertTouchDrag: true,
			},
			handleScale: {
				mouseWheel: true,
				pinch: true,
				axisPressedMouseMove: {
					time: true,
					price: true,
				},
				axisDoubleClickReset: {
					time: true,
					price: true,
				},
			},
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
		this.getMainPriceScale()?.applyOptions({
			mode: this.state.isLogPriceScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
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

		const lastCandle = this.state.candles[this.state.candles.length - 1];
		const overlayBaseCurrency = (
			this.state.isLoading
				? this.state.baseCurrency
				: this.state.loadedBaseCurrency || this.state.baseCurrency || this.state.defaultBaseCurrency
		).trim().toUpperCase();
		const isOverlayMarketLoaded = (
			overlayBaseCurrency === this.state.loadedBaseCurrency
			&& !this.state.isLoading
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
		const profileTotal = this.state.profile?.total_usd;
		const profileBalances = Array.isArray(this.state.profile?.balances)
			? this.state.profile.balances
			: [];
		const orderTicket = this.state.orderTicket;
		const orderHover = this.state.orderScaleHover;
		const ticketAvailable = orderTicket ? this.getDisplayedBalanceForSide(orderTicket.side) : null;
		const ticketSide = orderTicket?.side === "SELL" ? "SELL" : "BUY";
		const ticketOrderType = this.normalizeOrderTypeForSide(ticketSide, orderTicket?.orderType);
		const ticketSubmitLabel = `${ticketSide} ${this.getOrderTypeLabel(ticketOrderType)}`;
		const ticketActionSideLabel = ticketSide.toLowerCase();
		const ticketBaseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency || "").trim().toUpperCase();
		const ticketPrimaryOrderType = orderTicket
			? this.getTicketPrimaryOrderType({ ...orderTicket, orderType: ticketOrderType })
			: "LIMIT";
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
		const ticketBaseAmount = orderTicket && Number.isFinite(ticketAmountValue) && ticketAmountValue > 0
			? orderTicket.amountMode === "BASE"
				? ticketAmountValue
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
		const ticketHasPreviewDisplay = ticketHasMatchingPreview;
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
		const sellPreviewSummary = isSellTicket && ticketHasValidPreview
			? getSellPreviewTicketSummary(
				ticketPreview,
				isSellUsdPayMode ? ticketAmountValue : null,
			)
			: null;
		const sellSummaryReady = Boolean(sellPreviewSummary);
		const ticketPreviewTotal = buyUsdPreviewSummary
			? buyUsdPreviewSummary.total
			: sellPreviewSummary
				? sellPreviewSummary.total
				: previewMatchesAmount
					? isSellTicket
						? getSellPreviewTicketSummary(
							ticketPreview,
							isSellUsdPayMode ? ticketAmountValue : null,
						)?.total
						: Number(ticketPreview?.order_total)
					: isSellTicket
						? NaN
						: ticketUsdTotal;
		const ticketPreviewFee = buyUsdPreviewSummary
			? buyUsdPreviewSummary.fee
			: sellPreviewSummary
				? sellPreviewSummary.fee
				: previewMatchesAmount
					? isSellTicket
						? getSellPreviewTicketSummary(
							ticketPreview,
							isSellUsdPayMode ? ticketAmountValue : null,
						)?.fee
						: Number(ticketPreview?.commission_total)
					: NaN;
		const ticketPreviewQuoteSize = buyUsdPreviewSummary
			? buyUsdPreviewSummary.value
			: sellPreviewSummary
				? sellPreviewSummary.value
				: previewMatchesAmount
					? isSellTicket
						? getSellPreviewTicketSummary(
							ticketPreview,
							isSellUsdPayMode ? ticketAmountValue : null,
						)?.value
						: Number(ticketPreview?.quote_size)
					: NaN;
		const ticketPreviewBaseSize = previewMatchesAmount
			? getOrderPreviewBaseSize(ticketPreview)
			: NaN;
		const ticketPreviewTotalLabel = Number.isFinite(ticketPreviewTotal) && ticketPreviewTotal > 0
			? formatUsdCents(ticketPreviewTotal)
			: orderTicket?.isPreviewLoading && !isBuyUsdPayMode && !(isSellTicket && isSellUsdPayMode)
				? "..."
				: "--";
		const ticketPreviewBaseAmountLabel = isSellCoinAmountTicket && Number.isFinite(ticketAmountValue) && ticketAmountValue > 0
			? `${this.getBaseAmountInputValue(ticketAmountValue)} ${ticketBaseCurrency}`
			: isBuyCoinAmountTicket && Number.isFinite(ticketAmountValue) && ticketAmountValue > 0
				? `${this.getBaseAmountInputValue(ticketAmountValue)} ${ticketBaseCurrency}`
				: previewMatchesAmount && Number.isFinite(ticketPreviewBaseSize) && ticketPreviewBaseSize > 0
					? `${this.getBaseAmountInputValue(ticketPreviewBaseSize)} ${ticketBaseCurrency}`
					: ticketSummaryPending || orderTicket?.isPreviewLoading
						? "..."
						: "--";
		const ticketPreviewFeeLabel = Number.isFinite(ticketPreviewFee)
			? formatUsdCents(ticketPreviewFee)
			: (ticketSummaryPending || orderTicket?.isPreviewLoading) && !(isSellTicket && sellSummaryReady)
				? "..."
				: "--";
		const ticketPreviewQuoteSizeLabel = (ticketSide === "BUY" || isSellTicket)
			? (isSellTicket ? sellSummaryReady : previewMatchesAmount)
				&& Number.isFinite(ticketPreviewQuoteSize)
				&& ticketPreviewQuoteSize > 0
				? formatUsdCents(ticketPreviewQuoteSize)
				: (ticketSummaryPending || orderTicket?.isPreviewLoading) && !(isSellTicket && sellSummaryReady)
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
		const ticketBracketProfit = isSellBracketTicket
			&& Number.isFinite(ticketBracketCoinAmount)
			&& ticketBracketCoinAmount > 0
			&& Number.isFinite(ticketTakeProfitPrice)
			&& ticketTakeProfitPrice > 0
			? ticketBracketCoinAmount * ticketTakeProfitPrice
			: NaN;
		const ticketBracketLoss = isSellBracketTicket
			&& Number.isFinite(ticketBracketCoinAmount)
			&& ticketBracketCoinAmount > 0
			&& Number.isFinite(ticketStopLossPrice)
			&& ticketStopLossPrice > 0
			? ticketBracketCoinAmount * ticketStopLossPrice
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
		const ticketActionLabel = orderTicket?.isSubmitting
			? "Placing..."
			: orderTicket?.isPreviewLoading
				? "Updating..."
				: ticketHasValidPreview
					? `Place ${ticketActionSideLabel}`
					: `Preview ${ticketActionSideLabel}`;
		const ticketValidation = this.getOrderTicketValidation(orderTicket);
		const ticketVisibleError = ticketSliderDisabled
			? orderTicket?.error || ticketValidation.error
			: orderTicket?.error
				|| ticketValidation.error
				|| orderTicket?.previewError;
		const ticketMessageIsSuccess = String(ticketVisibleError).startsWith("Order placed");
		const orderTicketStyle = orderTicket ? this.getOrderTicketStyle(orderTicket) : null;
		return (
			<div className={classnames} ref={this.container}>
				<header className="e__toolbar">
					<svg
						className="e__toolbar-logo"
						viewBox="0 0 512 512"
						aria-hidden="true"
						focusable="false"
					>
						<path d="M205.2,81.9L33.1,380c-22.6,39,5.5,87,49.8,87c42.5,0,64.4-69.7,172.1-69.7c117.7,0,129.5,69.7,172.1,69.7c44.3,0,72.5-48,49.8-87L305.6,81.9C283.2,43,227.8,43,205.2,81.9z" />
					</svg>
					<form className="e__market-form" onSubmit={this.handleProductSubmit}>
						<div className="e__market-form__row">
							<CoinsDropdown
								baseCurrency={this.state.baseCurrency}
								isClosing={this.state.closingDropdowns.monitor}
								isHovered={this.state.isCurrencyPickerHovered}
								isLoading={this.state.isLoading}
								isOpen={this.state.isMonitorOpen}
								monitorError={this.state.monitorError}
								onBaseCurrencyChange={baseCurrency => this.setState({ baseCurrency })}
								onHoverChange={isCurrencyPickerHovered => this.setState({ isCurrencyPickerHovered })}
								onOpen={this.openMonitorDropdown}
								onTickerClick={this.handleMonitorTickerLinkClick}
								onToggle={this.toggleMonitorDropdown}
								tickers={this.state.monitorTickers}
							/>
							<button type="submit" disabled={this.state.isLoading}>
								Apply
							</button>
						</div>
					</form>

					<div className="e__profile">
						<button
							className="e__profile-refresh"
							type="button"
							onClick={this.forceRefreshAccount}
							disabled={this.state.isAccountRefreshing}
							aria-label="Refresh balances and orders"
							title="Refresh balances and orders"
						>
							<span className={this.state.isAccountRefreshing ? "e__profile-refresh-icon is-spinning" : "e__profile-refresh-icon"}>
								↻
							</span>
						</button>
						<OrdersDropdown
							error={this.state.allOrdersError}
							isClosing={this.state.closingDropdowns.orders}
							isLoading={this.state.isOrdersLoading}
							isOpen={this.state.isOrdersOpen}
							onCancelOrder={this.cancelOrder}
							onCurrencyClick={(event, currency) => this.handleCurrencyNavigationLinkClick(event, currency, "orders")}
							onToggle={() => this.setAnimatedDropdown("orders", !this.state.isOrdersOpen, {
								close: ["profile"],
								onOpen: this.loadAllOrders,
							})}
							orders={this.state.allOrders}
						/>
						<BalanceDropdown
							balanceHistory={this.state.balanceHistory}
							balanceHistoryError={this.state.balanceHistoryError}
							balanceHistoryLoadedPeriod={this.state.balanceHistoryLoadedPeriod}
							balanceHistoryLoading={this.state.balanceHistoryLoading}
							balanceHistoryPeriod={this.state.balanceHistoryPeriod}
							balances={profileBalances}
							error={this.state.profileError}
							getBookmarkDelta={this.getBalanceBookmarkDelta}
							isClosing={this.state.closingDropdowns.profile}
							isLoading={this.state.isProfileLoading}
							isOpen={this.state.isProfileOpen}
							isTotalExpanded={Boolean(this.state.appSettings.balanceHistoryExpanded)}
							onCurrencyClick={(event, currency) => this.handleCurrencyNavigationLinkClick(event, currency, "profile")}
							onHistoryPeriodChange={this.setBalanceHistoryPeriod}
							onTotalExpandedChange={balanceHistoryExpanded => this.updateAppSettings({ balanceHistoryExpanded })}
							onToggle={() => this.setAnimatedDropdown("profile", !this.state.isProfileOpen, {
								close: ["orders"],
								onOpen: this.loadBalanceHistory,
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
					<div className="e__chart" ref={this.chartRef} />
					{this.renderOverlay()}
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
						isClosing={this.state.isOrderTicketClosing}
						isOrderTypeMenuOpen={this.state.isOrderTypeMenuOpen}
						messageIsSuccess={ticketMessageIsSuccess}
						onAmountBlur={this.formatOrderAmountInput}
						onAmountChange={this.updateOrderAmount}
						onAmountKeyDown={this.handleOrderAmountKeyDown}
						onCancel={this.closeOrderTicket}
						onFractionChange={this.setOrderFraction}
						onFractionCommit={this.flushOrderPreview}
						onFractionPreset={this.applyOrderFractionPreset}
						onOrderTypeMenuToggle={() => {
							if (ticketPrimaryOrderType !== "STOP") {
								this.setOrderType("STOP_LIMIT");
							}

							this.setState(prev => ({ isOrderTypeMenuOpen: !prev.isOrderTypeMenuOpen }));
						}}
						onPriceFieldChange={this.updateOrderPriceField}
						onPriceFieldFocus={field => this.updateOrderTicket({ activePriceField: field })}
						onSellStopOrderTypeChange={this.setSellStopOrderType}
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
						ticketSide={ticketSide}
						visibleError={ticketVisibleError}
					/>
					<div className="e__price-overlay">
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

					<div className="e__indicator-toggles" ref={this.indicatorTogglesRef} aria-label="Chart indicators">
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
							className={this.state.showHistogramIndicator ? "e__indicator-toggle is-active" : "e__indicator-toggle"}
							onClick={() => this.toggleIndicator("histogram")}
							aria-pressed={this.state.showHistogramIndicator}
						>
							HSTGRM
						</button>
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
