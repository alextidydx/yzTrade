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
	TickMarkType,
} from 'lightweight-charts';

import {
	BUY_FEE_ESTIMATE_RATE,
	DEFAULT_BASE_CURRENCY,
	DEPTH_RANGE_PADDING,
	DISTRIBUTION_BINS,
	DROPDOWN_TRANSITION_MS,
	INDICATOR_COOKIES,
	MIN_DEPTH_WIDTH_RATIO,
	MONITOR_TICKERS,
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
	chartDayFormatter,
	chartFullTimeFormatter,
	chartTimeFormatter,
	deleteBookmarkedPrice,
	estimateBuyQuoteSizeFromTotal,
	formatAmountWithIncrementFloor,
	formatBalanceAmount,
	formatChartEasternTime,
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
	getOrderErrorLabel,
	getPrecisionFromIncrement,
	getRoutePrefix,
	getVwapSessionKey,
	getWebSocketBase,
	hasPriceIncrement,
	sanitizeNumericInput,
	setBookmarkedPrice,
	setCookieBoolean,
} from "../../../utils/homeUtils";
export default (props) => (
	<Home {...props} payload={useParams()} history={useLocation()} navigate={useNavigate()} />
);

const APP_STATE_STALE_TIMEOUT_MS = 15000;
const LIVE_STALE_TIMEOUT_MS = 40000;

class Home extends React.Component {
	container = React.createRef();
	chartRef = React.createRef();
	orderTicketRef = React.createRef();
	indicatorTogglesRef = React.createRef();
	scaleControlsRef = React.createRef();

	state = {
		candles: [],
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
		monitorTickers: MONITOR_TICKERS.map(currency => ({
			currency,
			change_24h: null,
		})),
		monitorError: "",
		appBookmarks: null,
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
		periodDays: 7,
		periodGranularity: 300,
		loadedBaseCurrency: getBaseCurrencyFromPath(window.location.pathname),
		loadedPeriodDays: 7,
		loadedPeriodGranularity: 300,
		product: null,
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
	liveSocket = null;
	liveProductId = null;
	liveReconnectTimer = null;
	liveReconnectAttempt = 0;
	liveReconnectConfig = null;
	liveWatchdogTimer = null;
	lastLiveMessageAt = 0;
	appStateSocket = null;
	appStateReconnectTimer = null;
	appStateReconnectAttempt = 0;
	appStateWatchdogTimer = null;
	lastAppStateMessageAt = 0;
	isDisconnectingAppState = false;
	profileRefreshTimer = null;
	monitorRefreshTimer = null;
	tdRefreshTimers = [];
	lastTdRefreshBoundary = null;
	tdRefreshInFlight = false;
	marketRequestId = 0;
	isMarketTransitioning = false;
	isDisconnectingLive = false;
	suppressMeasurementClick = false;
	profileRequestId = 0;
	dropdownCloseTimers = {};
	orderTicketCloseTimer = null;

	componentDidMount() {
		window.addEventListener('resize', this.handleResize);
		window.addEventListener('keydown', this.handleKeyDown);
		window.addEventListener('pointermove', this.handleMeasurementDragMove);
		window.addEventListener('pointerup', this.handleMeasurementDragEnd);
		document.addEventListener('pointerdown', this.handleDocumentPointerDown);
		this.initChart();
		this.loadAppState();
		this.connectAppStateSocket();
		this.loadMarket();
		this.loadProfile();
		this.loadAllOrders();
		this.loadMonitorTickers();
		this.profileRefreshTimer = window.setInterval(this.loadProfile, 5000);
		this.monitorRefreshTimer = window.setInterval(this.loadMonitorTickers, 60000);
	}

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

		if (prevProps.history.pathname === this.props.history.pathname) return;

		const baseCurrency = getBaseCurrencyFromPath(this.props.history.pathname);

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

		if (this.monitorRefreshTimer) {
			window.clearInterval(this.monitorRefreshTimer);
		}

		Object.values(this.dropdownCloseTimers).forEach(timer => window.clearTimeout(timer));
		if (this.orderTicketCloseTimer) {
			window.clearTimeout(this.orderTicketCloseTimer);
		}
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

		if (this.state.isLogPriceScale && lower > 0 && upper > 0 && anchorPrice > 0) {
			const logLower = Math.log(lower);
			const logUpper = Math.log(upper);
			const logAnchor = Math.log(anchorPrice);

			nextFrom = Math.exp(logAnchor - (logAnchor - logLower) * zoomFactor);
			nextTo = Math.exp(logAnchor + (logUpper - logAnchor) * zoomFactor);
		}

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
		this.chart.setCrosshairPosition(price, time, this.candleSeries);
	};

	clearNativeCrosshair = () => {
		this.chart?.clearCrosshairPosition?.();
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

		const nextHoveredVolumeIndex = this.getHoveredCandleIndexFromX(x);

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

	handleResize = () => {
		if (!this.chart || !this.chartRef.current) return;

		const width = this.chartRef.current.clientWidth;
		const height = this.chartRef.current.clientHeight;

		this.chart.applyOptions({ width, height });
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
		const loadedFrom = Number(candles[0].time);
		const loadedTo = Number(candles[candles.length - 1].time);

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

		return Number(this.state.loadedPeriodDays) <= 7 ? 3600 : 21600;
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

		const oldestCandle = this.state.candles[0];
		const oldestTime = Number(oldestCandle?.time);
		const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).trim().toUpperCase();
		const granularity = this.getLoadedCandleGranularity();
		const requestId = this.marketRequestId;

		if (!baseCurrency || !Number.isFinite(oldestTime) || !Number.isFinite(granularity)) return;

		this.setState({ isLoadingOlderCandles: true });

		api.getCandles({
			product_id: `${baseCurrency}-USD`,
			days: Number(this.state.loadedPeriodDays) || 7,
			granularity,
			end_time: Math.max(0, oldestTime - 1),
			limit: 300,
			_: Date.now(),
		}).then(response => {
			if (requestId !== this.marketRequestId || baseCurrency !== this.state.loadedBaseCurrency) return;

			const olderCandles = this.normalizeCandles(response.data)
				.filter(candle => Number(candle.time) < oldestTime);

			if (!olderCandles.length) {
				this.setState({
					isLoadingOlderCandles: false,
					hasMoreOlderCandles: false,
				});
				return;
			}

			const candlesByTime = new Map();

			[...olderCandles, ...this.state.candles].forEach(candle => {
				candlesByTime.set(Number(candle.time), candle);
			});

			const candles = [...candlesByTime.values()]
				.sort((a, b) => Number(a.time) - Number(b.time));

			this.setState({
				candles,
			}, () => {
				this.candleSeries?.setData(candles);
				this.syncVolumeSeries(candles);
				this.syncVwapSeries(candles);
				this.syncTdSequentialSeries(this.state.tdSequential, candles);

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

	refitViewport = () => {
		if (!this.chart) return;

		this.chart.priceScale('right').applyOptions({ autoScale: true });
		this.chart.timeScale().fitContent();
		this.scheduleOverlayUpdate();

		requestAnimationFrame(() => {
			if (!this.chart) return;

			this.chart.priceScale('right').applyOptions({ autoScale: true });
			this.chart.timeScale().fitContent();
			this.scheduleOverlayUpdate();
		});
	};

	getBookmarkedPriceForCurrency = (currency) => {
		const normalizedCurrency = String(currency || "").trim().toUpperCase();

		if (!normalizedCurrency) return null;

		if (this.state.appBookmarks && typeof this.state.appBookmarks === "object") {
			const price = Number(this.state.appBookmarks[normalizedCurrency]);

			return Number.isFinite(price) ? price : null;
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
					.map(([currency, price]) => [String(currency || "").toUpperCase(), Number(price)])
					.filter(([currency, price]) => currency && Number.isFinite(price))
			)
			: {};
		const currency = this.state.loadedBaseCurrency || this.state.baseCurrency;
		const bookmarkedPrice = Number(appBookmarks[String(currency || "").toUpperCase()]);

		this.setState({
			appBookmarks,
			bookmarkedPrice: Number.isFinite(bookmarkedPrice) ? bookmarkedPrice : null,
		}, this.scheduleOverlayUpdate);
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
		this.clearLiveWatchdog();

		if (this.liveReconnectTimer) {
			window.clearTimeout(this.liveReconnectTimer);
			this.liveReconnectTimer = null;
		}

		this.liveReconnectAttempt = 0;
		this.liveReconnectConfig = null;

		if (!this.liveSocket) {
			this.isDisconnectingLive = false;
			return;
		}

		this.liveSocket.onopen = null;
		this.liveSocket.onmessage = null;
		this.liveSocket.onerror = null;
		this.liveSocket.onclose = null;
		this.liveSocket.close();
		this.liveSocket = null;
		this.liveProductId = null;
		this.setState({ isLive: false });
		this.isDisconnectingLive = false;
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
		if (this.isDisconnectingLive || !this.liveReconnectConfig || this.liveReconnectTimer) return;

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
		this.liveReconnectConfig = { productId, periodDays, periodGranularity, depth };
		this.liveReconnectAttempt = 0;
		this.openLiveSocket(this.liveReconnectConfig);
	};

	openLiveSocket = ({ productId, periodDays, periodGranularity, depth }) => {
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

		socket.onopen = () => {
			if (socket === this.liveSocket) {
				this.liveReconnectAttempt = 0;
				this.markLiveMessage();
			}
		};

		socket.onmessage = (event) => {
			let message = null;

			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}

			if (socket !== this.liveSocket || message.product_id !== this.liveProductId) return;

			this.markLiveMessage();

			if (message.type === "subscribed") {
				if (message.stream === "market") {
					this.liveReconnectAttempt = 0;
					this.setState({ isLive: true });
				} else if (message.stream === "orders") {
					this.setState({ orderError: "" });
				}
			} else if (message.type === "trade") {
				if (!this.state.isLive) {
					this.setState({ isLive: true });
				}
				this.applyLiveTrade(message);
			} else if (message.type === "orders_update") {
				this.applyLiveOrders(message);
			} else if (message.type === "depth_update") {
				this.applyLiveDepth(message);
			} else if (message.type === "heartbeat") {
				if (!this.state.isLive) {
					this.setState({ isLive: true });
				}
			} else if (message.type === "order_stream_error") {
				this.setState({
					orderError: message.message || "Live order stream failed.",
				});
			} else if (message.type === "error") {
				this.setState({ isLive: false });
			}
		};

		socket.onerror = () => {
			if (socket === this.liveSocket) {
				this.setState({
					error: "Live stream connection failed.",
					isLive: false,
				});
				this.scheduleLiveReconnect();
			}
		};

		socket.onclose = () => {
			if (socket === this.liveSocket) {
				this.clearLiveWatchdog();
				this.liveSocket = null;
				this.setState({ isLive: false });
				this.scheduleLiveReconnect();
			}
		};
	};

	applyLiveDepth = (message) => {
		const depth = message.depth;

		if (!depth || !Array.isArray(depth.bids) || !Array.isArray(depth.asks)) return;

		this.setState(prev => {
			if (!prev.depth) return null;

			const minPrice = Number(prev.depth.min_price);
			const maxPrice = Number(prev.depth.max_price);
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
					current_price: Number.isFinite(Number(depth.current_price))
						? Number(depth.current_price)
						: prev.depth.current_price,
					bids,
					asks,
				},
			};
		}, this.scheduleOverlayUpdate);
	};

	applyLiveOrders = (message) => {
		const updatedOrders = Array.isArray(message.orders) ? message.orders : [];
		const removedOrderIds = new Set(Array.isArray(message.removed_order_ids) ? message.removed_order_ids : []);

		this.setState(prev => {
			const ordersById = new Map();

			(Array.isArray(prev.orders) ? prev.orders : []).forEach(order => {
				if (order?.id && !removedOrderIds.has(order.id)) {
					ordersById.set(order.id, order);
				}
			});

			updatedOrders.forEach(order => {
				if (order?.id) {
					const existing = ordersById.get(order.id);
					const nextOrder = { ...existing, ...order };

					if (
						(!Array.isArray(nextOrder.bracket_legs) || !nextOrder.bracket_legs.length)
						&& Array.isArray(existing?.bracket_legs)
						&& existing.bracket_legs.length
					) {
						nextOrder.bracket_legs = existing.bracket_legs;
					}

					ordersById.set(order.id, nextOrder);
				}
			});

			return {
				orders: Array.from(ordersById.values()),
				orderError: "",
			};
		}, this.scheduleOverlayUpdate);
	};

	applyLiveTrade = (trade) => {
		const price = Number(trade.price);
		const size = Number(trade.size) || 0;
		const time = Number(trade.time);
		let didStartNewCandle = false;

		if (!Number.isFinite(price) || !Number.isFinite(time)) return;

		this.setState(prev => {
			const candles = [...prev.candles];
			const last = candles[candles.length - 1];

			if (!last || time > last.time) {
				didStartNewCandle = true;
				candles.push({
					time,
					open: price,
					high: price,
					low: price,
					close: price,
					volume: size,
				});
			} else if (time === last.time) {
				candles[candles.length - 1] = {
					...last,
					high: Math.max(last.high, price),
					low: Math.min(last.low, price),
					close: price,
					volume: (last.volume || 0) + size,
				};
			} else {
				return null;
			}

			return {
				candles,
				depth: prev.depth
					? {
						...prev.depth,
						current_price: price,
					}
					: prev.depth,
			};
		}, () => {
			const candle = this.state.candles[this.state.candles.length - 1];

			if (!candle) return;

			this.candleSeries.update(candle);
			this.volumeSeries.update({
				time: candle.time,
				value: this.getCandleVolumeUsd(candle),
				color: this.getVolumeBarColor(
					candle,
					this.state.hoveredVolumeIndex === this.state.candles.length - 1
				),
			});
			this.syncVwapSeries(this.state.candles);
			if (didStartNewCandle) {
				this.refreshTdSequentialAfterClosedCandle(time);
			}
			this.scheduleOverlayUpdate();
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
		const periodDays = Number(this.state.loadedPeriodDays || this.state.periodDays) || 7;

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
		const periodDays = Number(this.state.periodDays) || 7;
		const periodGranularity = this.state.periodGranularity ? Number(this.state.periodGranularity) : null;

		if (!baseCurrency) {
			this.setState({
				error: "Enter a base currency, for example GFI.",
				isLoading: false,
			});
			return;
		}

		const productId = `${baseCurrency}-USD`;
		this.syncCurrencyPath(baseCurrency);

		const requestId = ++this.marketRequestId;
		this.isMarketTransitioning = true;
		const shouldPreserveRange =
			baseCurrency === this.state.loadedBaseCurrency
			&& periodDays === this.state.loadedPeriodDays
			&& periodGranularity === this.state.loadedPeriodGranularity;
		const rangeSnapshot = this.getVisibleRangeSnapshot();

		this.setState({
			isLoading: true,
			isLoadingOlderCandles: false,
			hasMoreOlderCandles: true,
			error: "",
			isLive: false,
			orderError: "",
			candles: [],
			depth: null,
			product: null,
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

				const candles = this.normalizeCandles(candlesResponse.data);

				if (!candles.length) {
					throw new Error(`Coinbase returned no candle data for ${productId}.`);
				}

				const timeframeMin = Math.min(...candles.map(candle => candle.low));
				const timeframeMax = Math.max(...candles.map(candle => candle.high));
				const latestPrice = candles[candles.length - 1].close;
				const maxDelta = Math.max(
					Math.abs(timeframeMax - latestPrice),
					Math.abs(latestPrice - timeframeMin)
				);
				const depthDelta = maxDelta * DEPTH_RANGE_PADDING;
				const depthRange = {
					min_price: latestPrice - depthDelta,
					max_price: latestPrice + depthDelta,
				};

				this.setState({
					candles,
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

					this.candleSeries.setData(candles);
					this.applyPriceSeriesFormat();
					this.syncVolumeSeries(candles);
					this.syncVwapSeries(candles);
					this.syncTdSequentialSeries(null, candles);
					this.handleResize();

					const didRestoreView = shouldPreserveRange
						? this.restoreVisibleRange(rangeSnapshot)
						: this.restoreVisibleTimeframeByDates(rangeSnapshot, candles);

					if (!didRestoreView) {
						this.refitViewport();
					}

					this.syncCurrencyPath(baseCurrency);
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
				depth: depthResponse.data,
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

	handleMonitorTickerClick = (baseCurrency) => {
		const normalizedBaseCurrency = String(baseCurrency || "").toUpperCase();

		if (!normalizedBaseCurrency) return;

		this.setState({
			baseCurrency: normalizedBaseCurrency,
			isMonitorOpen: false,
		}, this.loadMarket);
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
			if (requestId !== this.profileRequestId) return;

			this.setState({
				profile: response.data,
				profileError: "",
				isProfileLoading: false,
			});
		}).catch(error => {
			if (requestId !== this.profileRequestId) return;

			this.setState({
				profileError: error.response?.data?.detail || error.message || "Unable to load Coinbase balances.",
				isProfileLoading: false,
			});
		});
	};

	loadOrders = () => {
		const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).trim().toUpperCase();
		const productId = `${baseCurrency}-USD`;

		if (!baseCurrency) return Promise.resolve();

		return api.getOrders({
			product_id: productId,
			_: Date.now(),
		}).then(response => {
			this.setState({
				orders: Array.isArray(response.data?.orders) ? response.data.orders : [],
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
		this.setState({
			isOrdersLoading: !this.state.allOrders.length,
			allOrdersError: "",
		});

		return api.getOrders({
			product_id: `${(this.state.loadedBaseCurrency || this.state.baseCurrency).trim().toUpperCase()}-USD`,
			all_products: true,
			_: Date.now(),
		}).then(response => {
			this.setState({
				allOrders: Array.isArray(response.data?.orders) ? response.data.orders : [],
				allOrdersError: "",
				isOrdersLoading: false,
			});
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

	getAvailableBalanceForSide = (side = this.state.orderTicket?.side) => {
		const balances = Array.isArray(this.state.profile?.balances) ? this.state.profile.balances : [];
		const normalizedSide = side === "SELL" ? "SELL" : "BUY";

		if (normalizedSide === "SELL") {
			const baseCurrency = (this.state.loadedBaseCurrency || this.state.baseCurrency).toUpperCase();
			const balance = balances.find(item => item.currency === baseCurrency);

			return {
				currency: baseCurrency,
				amount: Number(balance?.available) || 0,
			};
		}

		const usd = balances.find(item => item.currency === "USD");
		const usdc = balances.find(item => item.currency === "USDC");
		const usdAmount = Number(usd?.available) || 0;
		const usdcAmount = Number(usdc?.available) || 0;

		return {
			currency: "USD/USDC",
			amount: Math.max(usdAmount, usdcAmount),
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

	getBuyQuoteBalance = (requiredAmount = 0) => {
		const balances = Array.isArray(this.state.profile?.balances) ? this.state.profile.balances : [];
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
		const savedOrderType = this.normalizeOrderTypeForSide(normalizedSide, saved.orderType);
		const ticket = {
			...saved,
			side: normalizedSide,
			orderType: savedOrderType,
			amountMode: this.getSavedAmountModeForSide(normalizedSide, saved),
			activePriceField: "price",
			anchorPrice: Number.isFinite(numericPrice) ? numericPrice : null,
			anchorOffsetY: ORDER_TICKET_ANCHOR_OFFSET_Y,
			anchorY: this.state.orderScaleHover?.y ?? this.state.chartSize.height / 2,
			price: priceValue,
			stopPrice: Number.isFinite(Number(saved.stopPrice)) ? this.getOrderPriceInputValue(saved.stopPrice) : priceValue,
			takeProfitPrice: Number.isFinite(Number(saved.takeProfitPrice)) ? this.getOrderPriceInputValue(saved.takeProfitPrice) : priceValue,
			stopLossPrice: Number.isFinite(Number(saved.stopLossPrice)) ? this.getOrderPriceInputValue(saved.stopLossPrice) : stopLossValue,
			amount: saved.amount ?? "0",
			error: "",
			isSubmitting: false,
		};

		return this.clampOrderTicketAmount({
			...ticket,
			fraction: this.getOrderFractionFromAmount(ticket),
		});
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
				fraction: ticket.fraction,
				amount: ticket.amount,
			}
			: null
	);

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
			amount: saved.amount ?? "0",
			error: "",
			isSubmitting: false,
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
		});
	};

	openOrderTicket = (event) => {
		event.preventDefault();
		event.stopPropagation();

		const hover = this.state.orderScaleHover;
		if (!hover) return;

		if (this.orderTicketCloseTimer) {
			window.clearTimeout(this.orderTicketCloseTimer);
			this.orderTicketCloseTimer = null;
		}

		const side = this.getDefaultOrderSideForPrice(hover.price);

		this.setState({
			orderTicket: this.getOrderTicketDefaults(hover.price, side),
			isOrderTicketClosing: false,
			lastOrderSide: side,
		});
	};

	applyOrderHoverPrice = (event) => {
		event.preventDefault();
		event.stopPropagation();

		const hover = this.state.orderScaleHover;
		if (!hover) return;

		if (!this.state.orderTicket) {
			if (this.orderTicketCloseTimer) {
				window.clearTimeout(this.orderTicketCloseTimer);
				this.orderTicketCloseTimer = null;
			}

			const side = this.getDefaultOrderSideForPrice(hover.price);

			this.setState({
				orderTicket: this.getOrderTicketDefaults(hover.price, side),
				isOrderTicketClosing: false,
				lastOrderSide: side,
			});
			return;
		}

		const field = this.state.orderTicket.activePriceField || "price";
		const allowedFields = ["price", "stopPrice", "takeProfitPrice", "stopLossPrice"];

		this.updateOrderPriceField(
			allowedFields.includes(field) ? field : "price",
			this.getOrderPriceInputValue(hover.price)
		);
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

	closeOrderTicket = () => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		if (this.orderTicketCloseTimer) {
			window.clearTimeout(this.orderTicketCloseTimer);
		}

		this.setState({
			isOrderTicketClosing: true,
			lastOrderSide: ticket?.side === "SELL" ? "SELL" : "BUY",
			savedOrderTickets: ticket
				? {
					...this.state.savedOrderTickets,
					[ticket.side]: this.getSavedOrderSnapshot(ticket),
				}
				: this.state.savedOrderTickets,
			orderScaleHover: null,
		});

		this.orderTicketCloseTimer = window.setTimeout(() => {
			this.orderTicketCloseTimer = null;
			this.setState({
				orderTicket: null,
				isOrderTicketClosing: false,
			});
		}, DROPDOWN_TRANSITION_MS);
	};

	updateOrderTicket = (patch) => {
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
		}));
	};

	setOrderType = (orderType) => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		this.updateOrderTicket({
			orderType: this.normalizeOrderTypeForSide(ticket.side, orderType),
		});
	};

	setSellStopOrderType = (orderType) => {
		this.setOrderType(orderType);
		this.setState({ isOrderTypeMenuOpen: false });
	};

	getOrderFractionFromAmount = (ticket, amountValue = ticket?.amount) => {
		if (!ticket) return 0;

		const amount = Number(amountValue);
		const maxAmount = this.getOrderMaxAmount(ticket);

		if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(maxAmount) || maxAmount <= 0) {
			return 0;
		}

		return Math.max(0, Math.min(1, amount / maxAmount));
	};

	getOrderReferencePrice = (ticket) => {
		if (!ticket) return NaN;

		const orderType = this.normalizeOrderTypeForSide(ticket.side, ticket.orderType);
		const price = Number(ticket.price);
		const takeProfitPrice = Number(ticket.takeProfitPrice);
		const lastPrice = Number(this.state.candles[this.state.candles.length - 1]?.close);

		if (orderType === "BRACKET" && Number.isFinite(takeProfitPrice) && takeProfitPrice > 0) {
			return takeProfitPrice;
		}

		if (orderType !== "MARKET" && Number.isFinite(price) && price > 0) {
			return price;
		}

		return Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : price;
	};

	getOrderMaxAmount = (ticket) => {
		if (!ticket) return 0;

		const available = this.getAvailableBalanceForSide(ticket.side);
		const referencePrice = this.getOrderReferencePrice(ticket);
		const availableAmount = Number(available.amount) || 0;

		if (ticket.side === "BUY") {
			return ticket.amountMode === "USD"
				? availableAmount
				: referencePrice > 0
					? estimateBuyQuoteSizeFromTotal(availableAmount) / referencePrice
					: 0;
		}

		return ticket.amountMode === "USD"
			? referencePrice > 0
				? availableAmount * referencePrice
				: 0
			: availableAmount;
	};

	getOrderRequiredBalance = (ticket) => {
		if (!ticket) return NaN;

		const amount = Number(ticket.amount);
		const referencePrice = this.getOrderReferencePrice(ticket);

		if (!Number.isFinite(amount) || amount <= 0) return NaN;

		if (ticket.side === "BUY") {
			return ticket.amountMode === "USD"
				? amount
				: referencePrice > 0
					? (amount * referencePrice) * (1 + BUY_FEE_ESTIMATE_RATE)
					: NaN;
		}

		return ticket.amountMode === "USD"
			? referencePrice > 0
				? amount / referencePrice
				: NaN
			: amount;
	};

	updateOrderAmount = (amount) => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;
		const sanitizedAmount = sanitizeNumericInput(amount);

		this.updateOrderTicket({
			amount: sanitizedAmount,
			fraction: this.getOrderFractionFromAmount(ticket, sanitizedAmount),
		});
	};

	formatOrderAmountInput = () => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		const amount = Number(ticket.amount);
		if (!Number.isFinite(amount)) return;

		const formattedAmount = this.getOrderAmountInputValue(ticket, amount);

		this.updateOrderTicket({
			amount: formattedAmount,
			fraction: this.getOrderFractionFromAmount(ticket, formattedAmount),
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
				error: "Enter amount.",
			};
		}

		if (orderType !== "MARKET" && orderType !== "BRACKET" && (!Number.isFinite(price) || price <= 0)) {
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

		const available = this.getAvailableBalanceForSide(side);
		const requiredBalance = this.getOrderRequiredBalance(ticket);
		const sourceBalance = side === "BUY"
			? this.getBuyQuoteBalance(requiredBalance)
			: available;

		if (!Number.isFinite(requiredBalance) || requiredBalance <= 0) {
			return {
				isValid: false,
				error: "Check amount and price.",
			};
		}

		if (requiredBalance > sourceBalance.amount) {
			return {
				isValid: false,
				error: `Insufficient ${sourceBalance.currency} balance.`,
			};
		}

		return {
			isValid: true,
			error: "",
			requiredBalance,
			sourceCurrency: sourceBalance.currency,
		};
	};

	toggleOrderAmountMode = () => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		const price = Number(ticket.price);
		const amount = Number(ticket.amount);
		const nextMode = ticket.amountMode === "USD" ? "BASE" : "USD";
		let nextAmount = ticket.amount;

		if (Number.isFinite(price) && price > 0 && Number.isFinite(amount) && amount > 0) {
			nextAmount = nextMode === "USD"
				? this.getOrderAmountInputValue({ ...ticket, amountMode: nextMode }, amount * price)
				: this.getOrderAmountInputValue({ ...ticket, amountMode: nextMode }, amount / price);
		}

		this.updateOrderTicket({
			amountMode: nextMode,
			amount: nextAmount,
			fraction: this.getOrderFractionFromAmount({
				...ticket,
				amountMode: nextMode,
			}, nextAmount),
		});
	};

	setOrderFraction = (fraction) => {
		const ticket = this.state.orderTicket;
		if (!ticket) return;

		const maxAmount = this.getOrderMaxAmount(ticket);

		this.updateOrderTicket({
			fraction,
			amount: maxAmount > 0
				? this.getOrderAmountInputValue(ticket, maxAmount * fraction)
				: "0",
		});
	};

	buildOrderTicketBody = (ticket = this.state.orderTicket) => {
		if (!ticket) {
			return {
				body: null,
				error: "Order ticket is closed.",
			};
		}

		const side = ticket.side === "SELL" ? "SELL" : "BUY";
		const orderType = this.normalizeOrderTypeForSide(side, ticket.orderType);
		const price = Number(ticket.price);
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

		const validation = this.getOrderTicketValidation(ticket);

		if (!validation.isValid) {
			return {
				body: null,
				error: validation.error || "Check order values.",
			};
		}

		const quoteCurrency = side === "BUY"
			? validation.sourceCurrency || "USD"
			: "USDC";

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
			body.quote_size = estimateBuyQuoteSizeFromTotal(amount);
			delete body.base_size;
		}

		if (orderType === "LIMIT") {
			body.limit_price = price;
		}

		if (orderType === "STOP_LIMIT") {
			body.limit_price = price;
			body.stop_price = Number(ticket.stopPrice);
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
		if (!ticket || ticket.isSubmitting) return;

		const orderBuild = this.buildOrderTicketBody(ticket);

		if (!orderBuild.body) {
			this.updateOrderTicket({
				...(orderBuild.patch || {}),
				error: orderBuild.error || "Check order values.",
			});
			return;
		}

		const body = orderBuild.body;
		const bodyKey = JSON.stringify(body);
		const preview = ticket.preview;
		const previewId = preview?.preview_id;
		const hasValidPreview = preview && ticket.previewBodyKey === bodyKey && !ticket.previewError;

		this.updateOrderTicket({ isSubmitting: true, error: "" });

		if (!hasValidPreview) {
			api.previewOrder(body)
				.then(response => {
					this.updateOrderTicket({
						isSubmitting: false,
						preview: response.data,
						previewBodyKey: bodyKey,
						previewError: "",
						error: "Preview ready. Review totals, then place order.",
					});
				})
				.catch(error => {
					const detail = error.response?.data?.detail || error.message || "Unable to preview Coinbase order.";
					const previewError = getOrderErrorLabel(detail, "Unable to preview Coinbase order.");

					this.updateOrderTicket({
						isSubmitting: false,
						preview: null,
						previewBodyKey: "",
						previewError,
						error: previewError,
					});
				});
			return;
		}

		api.placeOrder({
			...body,
			preview_id: previewId,
		})
			.then(() => {
				this.closeOrderTicket();
				this.loadOrders();
				this.loadAllOrders();
				this.loadProfile();
			})
			.catch(error => {
				const detail = error.response?.data?.detail || error.message || "Unable to place Coinbase order.";

				this.updateOrderTicket({
					isSubmitting: false,
					error: getOrderErrorLabel(detail, "Unable to place Coinbase order."),
				});
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
			this.loadProfile();
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

		const coordinate = this.chart.timeScale().timeToCoordinate(time);
		if (Number.isFinite(coordinate)) return coordinate;

		const { candles } = this.state;
		const numericTime = Number(time);

		if (!candles.length || !Number.isFinite(numericTime)) return null;

		const upperIndex = candles.findIndex(candle => candle.time >= numericTime);

		if (upperIndex === -1) {
			const lastIndex = candles.length - 1;
			const previous = candles[lastIndex - 1];
			const last = candles[lastIndex];
			const step = previous ? last.time - previous.time : 1;
			const logical = lastIndex + (numericTime - last.time) / step;
			const fallbackCoordinate = this.chart.timeScale().logicalToCoordinate?.(logical);

			return Number.isFinite(fallbackCoordinate) ? fallbackCoordinate : null;
		}

		if (upperIndex === 0) {
			const first = candles[0];
			const next = candles[1];
			const step = next ? next.time - first.time : 1;
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

	logicalToTime = (logical) => {
		const { candles } = this.state;

		if (!candles.length || !Number.isFinite(logical)) return null;
		if (candles.length === 1) return candles[0].time;

		const lowerIndex = Math.floor(logical);
		const upperIndex = Math.ceil(logical);
		const fallbackStep = candles[1].time - candles[0].time;
		const getTimeAtIndex = (index) => {
			if (candles[index]) return candles[index].time;
			if (index < 0) return candles[0].time + index * fallbackStep;

			return candles[candles.length - 1].time + (index - candles.length + 1) * fallbackStep;
		};
		const lowerTime = getTimeAtIndex(lowerIndex);
		const upperTime = getTimeAtIndex(upperIndex);

		if (lowerIndex === upperIndex) return lowerTime;

		return lowerTime + (upperTime - lowerTime) * (logical - lowerIndex);
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
			time: candle.time,
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
			this.vwapSeries[index].setData(session.data);
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

		this.tdSequentialSeries.setData(data);
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
			bookmarkedPrice,
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
		const timelineTicks = this.buildTimelineTicks(priceScaleLeft - 4);
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
			Math.max(chartSize.width * MIN_DEPTH_WIDTH_RATIO, availableDepthWidth)
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
					label: `${order.role === "take_profit" ? "TP " : order.role === "stop_loss" ? "SL " : ""}${this.formatOverlayPriceForProduct(price)} / ${formatOrderValue(order.total_value, order.amount, price, order.quote_size)}`,
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
		const bookmarkedPriceValue = Number(bookmarkedPrice);
		const bookmarkedY = Number.isFinite(bookmarkedPriceValue)
			? this.priceToY(bookmarkedPriceValue)
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
				y: Math.min(chartSize.height - 18, Math.max(chartSize.height * 0.72, hoveredVolumeY - 12)),
				text: formatUsdValue(hoveredVolumeValue),
			}
			: null;

		return (
			<svg className="e__market-overlay" width={chartSize.width} height={chartSize.height}>
				<g className="e__timeline-labels">
					{timelineTicks.map(tick => (
						<text
							key={`${tick.time}-${tick.label}`}
							x={tick.x}
							y={chartSize.height - 8}
							textAnchor="middle"
						>
							{tick.label}
						</text>
					))}
				</g>
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
							<text
								className="e__price-bookmark__delete"
								x={bookmarkedLineRight - orderCancelOffset}
								y={bookmarkedLabelY}
								textAnchor="middle"
								role="button"
								tabIndex={0}
								onClick={this.clearBookmarkedPrice}
							>
								x
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
							<text
								className="e__order-cancel"
								x={orderLineRight - orderCancelOffset}
								y={orderLabelYById.get(order.id) ?? Math.max(12, order.y - 5)}
								textAnchor="middle"
								role="button"
								tabIndex={0}
								onClick={event => this.cancelOrder(order, event)}
							>
								(x)
							</text>
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

	formatChartTick = (time, tickMarkType) => {
		return "";
	};

	buildTimelineTicks = (rightLimit) => {
		if (!this.chart || !this.state.candles.length) return [];

		const visibleLogicalRange = this.chart.timeScale().getVisibleLogicalRange?.();
		const loadedRange = this.getLoadedTimeRange();
		const from = visibleLogicalRange
			? this.logicalToTime(visibleLogicalRange.from)
			: loadedRange?.from;
		const to = visibleLogicalRange
			? this.logicalToTime(visibleLogicalRange.to)
			: loadedRange?.to;

		if (!Number.isFinite(from) || !Number.isFinite(to)) return [];

		const labels = new Set(["00:00", "06:00", "12:00", "18:00"]);
		const start = Math.floor((Math.min(from, to) - 3600) / 3600) * 3600;
		const end = Math.ceil((Math.max(from, to) + 3600) / 3600) * 3600;
		const ticks = [];

		for (let time = start; time <= end; time += 3600) {
			const timeLabel = formatChartEasternTime(time, chartTimeFormatter).replace(/^24:/, "00:");

			if (!labels.has(timeLabel)) continue;

			const x = this.timeToX(time);

			if (!Number.isFinite(x) || x < 0 || x > rightLimit) continue;

			ticks.push({
				time,
				x,
				label: timeLabel === "00:00"
					? formatChartEasternTime(time, chartDayFormatter)
					: timeLabel.replace(/^0(?=\d:)/, ""),
			});
		}

		return ticks.reduce((visibleTicks, tick) => {
			const previous = visibleTicks[visibleTicks.length - 1];

			if (!previous || tick.x - previous.x >= 34) {
				visibleTicks.push(tick);
			}

			return visibleTicks;
		}, []);
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
				timeFormatter: time => formatChartEasternTime(time, chartFullTimeFormatter),
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
				rightOffset: 52,
				tickMarkFormatter: this.formatChartTick,
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
				: this.state.loadedBaseCurrency || this.state.baseCurrency || DEFAULT_BASE_CURRENCY
		).trim().toUpperCase();
		const isOverlayMarketLoaded = (
			overlayBaseCurrency === this.state.loadedBaseCurrency
			&& !this.state.isLoading
			&& this.state.candles.length > 0
		);
		const hasOverlayPricePrecision = hasPriceIncrement(this.state.product?.quote_increment);
		const currentPrice = isOverlayMarketLoaded ? Number(lastCandle?.close) : NaN;
		const change24h = isOverlayMarketLoaded ? this.getPriceChange24h(currentPrice) : null;
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
			? orderTicket.amountMode === "USD"
				? Number.isFinite(ticketSummaryPrice) && ticketSummaryPrice > 0
					? ticketAmountValue / ticketSummaryPrice
					: null
				: ticketAmountValue
			: null;
		const ticketAvailableAmount = Number(ticketAvailable?.amount);
		const ticketAvailableLabel = ticketAvailable
			? `${ticketAvailable.currency === ticketBaseCurrency
				? this.getBaseAmountInputValue(ticketAvailableAmount)
				: formatBalanceAmount(ticketAvailableAmount)} ${ticketAvailable.currency}`
			: "--";
		const ticketBaseAmountLabel = ticketBaseAmount !== null
			? `${this.getBaseAmountInputValue(ticketBaseAmount)} ${ticketBaseCurrency}`
			: "--";
		const ticketPreview = orderTicket?.preview || null;
		const ticketPreviewTotal = Number(ticketPreview?.order_total);
		const ticketPreviewFee = Number(ticketPreview?.commission_total);
		const ticketPreviewQuoteSize = Number(ticketPreview?.quote_size);
		const ticketPreviewBaseSize = Number(ticketPreview?.base_size);
		const ticketPreviewTotalLabel = Number.isFinite(ticketPreviewTotal)
			? formatUsdCents(ticketPreviewTotal)
			: ticketUsdTotal !== null
				? formatUsdCents(ticketUsdTotal)
				: "--";
		const ticketPreviewBaseAmountLabel = Number.isFinite(ticketPreviewBaseSize) && ticketPreviewBaseSize > 0
			? `${this.getBaseAmountInputValue(ticketPreviewBaseSize)} ${ticketBaseCurrency}`
			: null;
		const ticketPreviewFeeLabel = Number.isFinite(ticketPreviewFee)
			? formatUsdCents(ticketPreviewFee)
			: "--";
		const ticketPreviewQuoteSizeLabel = Number.isFinite(ticketPreviewQuoteSize) && ticketPreviewQuoteSize > 0
			? formatUsdCents(ticketPreviewQuoteSize)
			: null;
		const ticketAmountUnitLabel = orderTicket?.amountMode === "USD" ? "USD" : ticketBaseCurrency;
		const ticketCurrentBody = orderTicket ? this.buildOrderTicketBody(orderTicket).body : null;
		const ticketCurrentBodyKey = ticketCurrentBody ? JSON.stringify(ticketCurrentBody) : "";
		const ticketHasValidPreview = Boolean(ticketPreview && orderTicket?.previewBodyKey === ticketCurrentBodyKey && !orderTicket?.previewError);
		const ticketActionLabel = orderTicket?.isSubmitting
			? ticketHasValidPreview
				? "Placing"
				: "Previewing"
			: ticketHasValidPreview
				? `Place ${ticketActionSideLabel}`
				: `Preview ${ticketActionSideLabel}`;
		const ticketValidation = this.getOrderTicketValidation(orderTicket);
		const ticketVisibleError = orderTicket?.error || ticketValidation.error;
		const ticketMessageIsSuccess = String(ticketVisibleError).startsWith("Order placed")
			|| String(ticketVisibleError).startsWith("Preview ready");
		const orderTicketStyle = orderTicket ? this.getOrderTicketStyle(orderTicket) : null;
		return (
			<div className={classnames} ref={this.container}>
				<header className="e__toolbar">
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
								onTickerClick={this.handleMonitorTickerLinkClick}
								onToggle={() => this.setAnimatedDropdown("monitor", !this.state.isMonitorOpen)}
								tickers={this.state.monitorTickers}
							/>
							<button type="submit" disabled={this.state.isLoading}>
								{this.state.isLoading ? "Loading" : "Apply"}
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
							balances={profileBalances}
							error={this.state.profileError}
							getBookmarkDelta={this.getBalanceBookmarkDelta}
							isClosing={this.state.closingDropdowns.profile}
							isLoading={this.state.isProfileLoading}
							isOpen={this.state.isProfileOpen}
							onCurrencyClick={(event, currency) => this.handleCurrencyNavigationLinkClick(event, currency, "profile")}
							onToggle={() => this.setAnimatedDropdown("profile", !this.state.isProfileOpen, {
								close: ["orders"],
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
						baseAmountLabel={ticketBaseAmountLabel}
						isClosing={this.state.isOrderTicketClosing}
						isOrderTypeMenuOpen={this.state.isOrderTypeMenuOpen}
						messageIsSuccess={ticketMessageIsSuccess}
						onAmountBlur={this.formatOrderAmountInput}
						onAmountChange={this.updateOrderAmount}
						onCancel={this.closeOrderTicket}
						onFractionChange={this.setOrderFraction}
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
						previewFeeLabel={ticketPreviewFeeLabel}
						previewQuoteSizeLabel={ticketPreviewQuoteSizeLabel}
						previewTotalLabel={ticketPreviewTotalLabel}
						submitLabel={ticketActionLabel}
						ticketAvailableLabel={ticketAvailableLabel}
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
