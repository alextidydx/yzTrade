import React, { useId, useState } from "react";

import "../../../styles/ui/dropdownShared.scss";
import "../../../styles/ui/balanceDropdown.scss";

import {
	formatBalanceAmount,
	formatUsdCents,
} from "../../../utils/homeUtils";

const getBalanceCurrency = (balance) => String(balance?.currency || "").trim().toUpperCase();

const defaultGetBalanceUsdValue = (balance) => {
	const currency = getBalanceCurrency(balance);

	if (currency === "USD" || currency === "USDC") {
		return Number(balance?.total);
	}

	return Number(balance?.usd_value);
};

const isBookmarkedCurrency = (currency, appBookmarks, getBookmarkedPrice) => {
	const key = String(currency || "").trim().toUpperCase();

	if (!key) return false;

	if (appBookmarks && typeof appBookmarks === "object") {
		if (Object.prototype.hasOwnProperty.call(appBookmarks, key)) {
			const price = Number(appBookmarks[key]);

			return Number.isFinite(price) && price > 0;
		}

		// App state loaded but this currency isn't bookmarked there.
		if (appBookmarks !== null) return false;
	}

	const fallbackPrice = Number(getBookmarkedPrice?.(key));

	return Number.isFinite(fallbackPrice) && fallbackPrice > 0;
};

const listBookmarkedCurrencies = (appBookmarks, getBookmarkedPrice) => {
	const currencies = new Set();

	if (appBookmarks && typeof appBookmarks === "object") {
		Object.keys(appBookmarks).forEach((key) => {
			if (isBookmarkedCurrency(key, appBookmarks, getBookmarkedPrice)) {
				currencies.add(String(key).trim().toUpperCase());
			}
		});
	}

	return [...currencies];
};

const getVisibleBalances = (
	balances,
	appBookmarks,
	getBookmarkedPrice,
	resolveBalanceUsdValue = defaultGetBalanceUsdValue,
) => {
	const list = Array.isArray(balances) ? balances : [];
	const visible = [];
	const seen = new Set();

	list.forEach((balance) => {
		const currency = getBalanceCurrency(balance);

		if (!currency || seen.has(currency)) return;

		if (currency === "USDC") {
			visible.push(balance);
			seen.add(currency);
			return;
		}

		const balanceValue = resolveBalanceUsdValue(balance);
		const hasMaterialValue = Number.isFinite(balanceValue) && balanceValue >= 0.99;

		if (hasMaterialValue) {
			visible.push(balance);
			seen.add(currency);
			return;
		}

		if (currency === "USD") return;

		if (isBookmarkedCurrency(currency, appBookmarks, getBookmarkedPrice)) {
			visible.push(balance);
			seen.add(currency);
		}
	});

	listBookmarkedCurrencies(appBookmarks, getBookmarkedPrice).forEach((currency) => {
		if (seen.has(currency)) return;

		const existing = list.find(balance => getBalanceCurrency(balance) === currency);

		visible.push(existing || {
			currency,
			available: 0,
			hold: 0,
			total: 0,
			usd_price: null,
			usd_value: 0,
			product_id: `${currency}-USD`,
		});
		seen.add(currency);
	});

	return visible;
};

const BALANCE_PERIODS = [
	{ key: "day", label: "DAY", seconds: 24 * 60 * 60 },
	{ key: "week", label: "WEEK", seconds: 7 * 24 * 60 * 60 },
	{ key: "30d", label: "30D", seconds: 30 * 24 * 60 * 60 },
	{ key: "all", label: "ALL", seconds: null },
];

const DAY_SECONDS = 24 * 60 * 60;

const isDailyBalancePeriod = period => period !== "day";

const getLocalDayStart = (time) => {
	const date = new Date(Number(time) * 1000);

	return Math.floor(
		new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000,
	);
};

const aggregateBalanceHistoryByDay = (points) => {
	if (!Array.isArray(points) || !points.length) return [];

	const buckets = new Map();

	points.forEach((point) => {
		const totalUsd = Number(point.total_usd);
		if (!Number.isFinite(totalUsd)) return;

		const dayStart = getLocalDayStart(point.time);
		const bucket = buckets.get(dayStart);

		if (bucket) {
			bucket.sum += totalUsd;
			bucket.count += 1;
		} else {
			buckets.set(dayStart, { sum: totalUsd, count: 1 });
		}
	});

	return [...buckets.entries()]
		.sort((left, right) => left[0] - right[0])
		.map(([dayStart, { sum, count }]) => ({
			time: dayStart + DAY_SECONDS / 2,
			total_usd: sum / count,
		}));
};

const formatBalanceHistoryTime = (time, options = {}) => {
	const { daily = false, includeYear = false } = options;
	const date = new Date(Number(time) * 1000);

	if (daily) {
		return date.toLocaleString("en-US", {
			month: "short",
			day: "2-digit",
			...(includeYear ? { year: "numeric" } : {}),
		});
	}

	return date.toLocaleString("en-US", {
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
};

const buildSmoothLinePath = (plotPoints, xForTime, yForValue) => {
	if (!plotPoints.length) return "";

	const coords = plotPoints.map(point => ({
		x: xForTime(point.time),
		y: yForValue(point.total_usd),
	}));

	if (coords.length === 1) {
		return `M ${coords[0].x.toFixed(2)} ${coords[0].y.toFixed(2)}`;
	}

	let path = `M ${coords[0].x.toFixed(2)} ${coords[0].y.toFixed(2)}`;

	for (let index = 0; index < coords.length - 1; index++) {
		const current = coords[index];
		const next = coords[index + 1];
		const controlX = (current.x + next.x) / 2;

		path += ` C ${controlX.toFixed(2)} ${current.y.toFixed(2)}, ${controlX.toFixed(2)} ${next.y.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
	}

	return path;
};

const BalanceHistoryPlot = ({
	error,
	isColorLine,
	isLoading,
	onColorLineChange,
	onPeriodChange,
	period,
	points,
	selectedPeriod,
	total,
}) => {
	const [activeIndex, setActiveIndex] = useState(null);
	const lineGradientId = `balance-history-${useId().replace(/:/g, "")}`;
	const width = 312;
	const height = 92;
	const padX = 8;
	const padTop = 2;
	const padBottom = 3;

	const useDailyPoints = isDailyBalancePeriod(period);
	const rawPoints = Array.isArray(points) ? points : [];
	const plotPoints = useDailyPoints
		? aggregateBalanceHistoryByDay(rawPoints)
		: rawPoints;
	const lastIndex = plotPoints.length - 1;

	// Default to latest point
	React.useEffect(() => {
		if (plotPoints.length > 0) {
			setActiveIndex(lastIndex);
		}
	}, [plotPoints.length, lastIndex]);

	const now = plotPoints[lastIndex]?.time || Math.floor(Date.now() / 1000);
	const firstTime = plotPoints[0]?.time || now;
	const lastTime = plotPoints[lastIndex]?.time || now;

	const values = plotPoints.map(point => Number(point.total_usd)).filter(Number.isFinite);
	const minValue = values.length ? Math.min(...values) : Number(total) || 0;
	const maxValue = values.length ? Math.max(...values) : Number(total) || 1;

	const valueRange = maxValue - minValue;
	let paddedMin;
	let paddedMax;

	if (valueRange <= 0) {
		const spread = Math.max(Math.abs(minValue) * 0.02, 1);
		paddedMin = minValue - spread;
		paddedMax = maxValue + spread;
	} else {
		const rangePadding = valueRange * 0.12;
		paddedMin = minValue - rangePadding;
		paddedMax = maxValue + rangePadding;
	}

	const timeSpan = Math.max(1, lastTime - firstTime);
	const valueSpan = Math.max(1, paddedMax - paddedMin);
	const includeYear = useDailyPoints && timeSpan > 365 * DAY_SECONDS;

	const xForTime = time => padX + ((time - firstTime) / timeSpan) * (width - padX * 2);
	const yForValue = value => height - padBottom - ((value - paddedMin) / valueSpan) * (height - padTop - padBottom);
	const axisY = height - 1;
	const firstDate = new Date(firstTime * 1000);
	const firstMidnight = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate()).getTime() / 1000;
	const dayMarks = [];

	for (
		let markTime = firstMidnight < firstTime ? firstMidnight + 24 * 60 * 60 : firstMidnight;
		markTime <= lastTime;
		markTime += 24 * 60 * 60
	) {
		dayMarks.push(markTime);
	}

	const linePath = buildSmoothLinePath(plotPoints, xForTime, yForValue);
	const lineGradientStops = plotPoints.map((point, index) => {
		const value = Number(point.total_usd);
		const previousValue = Number(plotPoints[index - 1]?.total_usd);
		const color = index === 0 || !Number.isFinite(value) || !Number.isFinite(previousValue)
			? "#7e8b98"
			: value > previousValue
				? "#20b28f"
				: value < previousValue
					? "#ee5858"
					: "#7e8b98";

		return {
			color: isColorLine ? color : "#7e8b98",
			offset: `${((Number(point.time) - firstTime) / timeSpan) * 100}%`,
		};
	});

	const activePoint = Number.isInteger(activeIndex) ? plotPoints[activeIndex] : null;
	const previousPoint = Number.isInteger(activeIndex) && activeIndex > 0
		? plotPoints[activeIndex - 1]
		: null;
	const activeValue = Number(activePoint?.total_usd);
	const previousValue = Number(previousPoint?.total_usd);
	const activeDeltaPercent = (
		Number.isFinite(activeValue)
		&& Number.isFinite(previousValue)
		&& previousValue > 0
	)
		? ((activeValue - previousValue) / previousValue) * 100
		: null;
	const activeDeltaClass = activeDeltaPercent === null
		? ""
		: activeDeltaPercent > 0
			? "e__balance-history__delta--up"
			: activeDeltaPercent < 0
				? "e__balance-history__delta--down"
				: "e__balance-history__delta--flat";
	const activeDeltaLabel = activeDeltaPercent === null
		? ""
		: `${activeDeltaPercent > 0 ? "+" : ""}${activeDeltaPercent.toFixed(1)}%`;

	const handleMove = (event) => {
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX - rect.left;
		let bestIndex = lastIndex;
		let bestDistance = Infinity;

		plotPoints.forEach((point, index) => {
			const distance = Math.abs(xForTime(point.time) - x);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestIndex = index;
			}
		});

		setActiveIndex(bestIndex);
	};

	const handleLeave = () => {
		setActiveIndex(lastIndex); // back to latest point
	};

	return (
		<div className="e__balance-history">
			<div className="e__balance-history__periods">
				{BALANCE_PERIODS.map(item => (
					<button
						key={item.key}
						className={[
							selectedPeriod === item.key ? "is-active" : "",
							isLoading && selectedPeriod === item.key ? "is-loading" : "",
						].filter(Boolean).join(" ")}
						type="button"
						onClick={() => onPeriodChange(item.key)}
					>
						{item.label}
					</button>
				))}
				<div className="e__balance-history__color-mode">
					<button
						className={isColorLine ? "is-active" : ""}
						type="button"
						onClick={() => onColorLineChange(true)}
					>
						COLOR
					</button>
					<span>/</span>
					<button
						className={!isColorLine ? "is-active" : ""}
						type="button"
						onClick={() => onColorLineChange(false)}
					>
						GRAY
					</button>
				</div>
			</div>

			{error ? (
				<div className="e__balance-history__empty">{error}</div>
			) : plotPoints.length ? (
				<svg
					className="e__balance-history__plot"
					viewBox={`0 0 ${width} ${height}`}
					role="img"
					aria-label="Total balance history"
					onMouseMove={handleMove}
					onMouseLeave={handleLeave}
				>
					<defs>
						<linearGradient
							id={lineGradientId}
							gradientUnits="userSpaceOnUse"
							x1={padX}
							x2={width - padX}
							y1={0}
							y2={0}
						>
							{lineGradientStops.map((stop, index) => (
								<stop
									key={`${stop.offset}-${index}`}
									offset={stop.offset}
									stopColor={stop.color}
								/>
							))}
						</linearGradient>
					</defs>
					{/* gaps can be added back here if you want */}
					<line className="e__balance-history__axis" x1={0} x2={width} y1={axisY} y2={axisY} />
					{dayMarks.map(markTime => (
						<line
							key={markTime}
							className="e__balance-history__day-mark"
							x1={xForTime(markTime)}
							x2={xForTime(markTime)}
							y1={axisY - 5}
							y2={axisY}
						/>
					))}
					<path
						className="e__balance-history__line"
						d={linePath}
						style={{ stroke: `url(#${lineGradientId})` }}
					/>

					{activePoint && (
						<g className="e__balance-history__hover">
							<line
								x1={xForTime(activePoint.time)}
								x2={xForTime(activePoint.time)}
								y1={0}
								y2={height}
							/>
							<circle
								cx={xForTime(activePoint.time)}
								cy={yForValue(activePoint.total_usd)}
								r={3}
							/>
						</g>
					)}
				</svg>
			) : (
				<div className="e__balance-history__empty">No balance history yet</div>
			)}

			<div className="e__balance-history__meta">
				<span>
					{activePoint 
						? formatUsdCents(activePoint.total_usd) 
						: formatUsdCents(total)}
					{activeDeltaLabel && (
						<b className={`e__balance-history__delta ${activeDeltaClass}`}>
							{` (${activeDeltaLabel})`}
						</b>
					)}
				</span>
				<strong>
					{activePoint
						? formatBalanceHistoryTime(activePoint.time, { daily: useDailyPoints, includeYear })
						: ""}
				</strong>
			</div>
		</div>
	);
};

const BookmarkMark = () => (
	<svg className="e__profile-row__bookmark-icon" viewBox="0 0 12 14" aria-hidden="true">
		<path d="M2 1.25h8a.75.75 0 0 1 .75.75v10.35l-4.35-2.5a.75.75 0 0 0-.8 0l-4.35 2.5V2A.75.75 0 0 1 2 1.25Z" />
	</svg>
);

const isDustBookmarkBalance = (
	balance,
	appBookmarks,
	getBookmarkedPrice,
	resolveBalanceUsdValue = defaultGetBalanceUsdValue,
) => {
	const currency = getBalanceCurrency(balance);
	const isCashBalance = currency === "USD" || currency === "USDC";
	const balanceValue = resolveBalanceUsdValue(balance);
	const hasMaterialValue = Number.isFinite(Number(balanceValue)) && Number(balanceValue) >= 0.99;

	return !isCashBalance
		&& !hasMaterialValue
		&& isBookmarkedCurrency(currency, appBookmarks, getBookmarkedPrice);
};

const BalanceRowContent = ({
	appBookmarks,
	balance,
	getBookmarkDelta,
	getBalanceUsdValue = defaultGetBalanceUsdValue,
	getBookmarkedPrice,
	onClearBookmark,
}) => {
	const currency = getBalanceCurrency(balance);
	const isCashBalance = currency === "USD" || currency === "USDC";
	const balanceValue = getBalanceUsdValue(balance);
	const availableBalance = Number(balance.available);
	const bookmarkDelta = getBookmarkDelta?.(balance);
	const isDustBookmarkRow = isDustBookmarkBalance(
		balance,
		appBookmarks,
		getBookmarkedPrice,
		getBalanceUsdValue,
	);

	if (isDustBookmarkRow) {
		const deltaClass = bookmarkDelta
			? `e__profile-row__bookmark ${bookmarkDelta.isPositive ? "e__profile-row__bookmark--up" : "e__profile-row__bookmark--down"}`
			: "e__profile-row__bookmark";

		return (
			<>
				<span className="e__profile-row__currency">{currency}</span>
				<span className="e__profile-row__amount" aria-hidden="true" />
				<span className="e__profile-row__value e__profile-row__value--dust">
					<small className={deltaClass}>
						{bookmarkDelta?.percentLabel || bookmarkDelta?.label || "--"}
						{bookmarkDelta?.fromBookmark ? <BookmarkMark /> : null}
					</small>
					<button
						className="e__profile-row__clear-bookmark"
						type="button"
						aria-label={`Remove ${currency} bookmark`}
						onClick={event => onClearBookmark?.(currency, event)}
					>
						<svg viewBox="-8 -8 16 16" aria-hidden="true">
							<circle r={7} />
							<path d="M -2.24 -2.24 L 2.24 2.24 M 2.24 -2.24 L -2.24 2.24" />
						</svg>
					</button>
				</span>
			</>
		);
	}

	return (
		<>
			<span className="e__profile-row__currency">{currency}</span>
			<span className="e__profile-row__amount">
				{isCashBalance
					? Number.isFinite(availableBalance)
						? formatUsdCents(availableBalance)
						: "--"
					: formatBalanceAmount(balance.total)}
			</span>
			<span className="e__profile-row__value">
				<span>{Number.isFinite(Number(balanceValue)) ? formatUsdCents(balanceValue) : "--"}</span>
				{bookmarkDelta && (
					<span className="e__profile-row__value e__profile-row__value--dust">
						<small className={`e__profile-row__bookmark ${bookmarkDelta.isPositive ? "e__profile-row__bookmark--up" : "e__profile-row__bookmark--down"}`}>
							{bookmarkDelta.label}
							{bookmarkDelta.fromBookmark ? <BookmarkMark /> : null}
						</small>
						{bookmarkDelta.fromBookmark && (
							<button
								className="e__profile-row__clear-bookmark"
								type="button"
								aria-label={`Remove ${currency} bookmark`}
								onClick={event => onClearBookmark?.(currency, event)}
							>
								<svg viewBox="-8 -8 16 16" aria-hidden="true">
									<circle r={7} />
									<path d="M -2.24 -2.24 L 2.24 2.24 M 2.24 -2.24 L -2.24 2.24" />
								</svg>
							</button>
						)}
					</span>
				)}
			</span>
		</>
	);
};

const BalanceDropdown = ({
	appBookmarks,
	balanceHistory,
	balanceHistoryError,
	balanceHistoryLoadedPeriod,
	balanceHistoryLoading,
	balanceHistoryPeriod,
	balances,
	error,
	getBookmarkDelta,
	getBalanceUsdValue = defaultGetBalanceUsdValue,
	getBookmarkedPrice,
	isClosing,
	isHistoryColored,
	isLoading,
	isOpen,
	isRefreshing,
	isTotalExpanded,
	onCurrencyClick,
	onClearBookmark,
	onHistoryColoredChange,
	onHistoryPeriodChange,
	onRefresh,
	onTotalExpandedChange,
	onToggle,
	total,
}) => {
	const visibleBalances = getVisibleBalances(
		balances,
		appBookmarks,
		getBookmarkedPrice,
		getBalanceUsdValue,
	);
	const totalLabel = Number.isFinite(Number(total)) ? formatUsdCents(total) : "--";

	return (
		<>
			<button
				className="e__profile-button"
				type="button"
				onClick={onToggle}
			>
				<strong>
					{isLoading ? "Loading" : totalLabel}
				</strong>
				<span className={`e__profile-caret ${isOpen ? "e__profile-caret--open" : ""}`}>
					<span className="e__dropdown-icon" aria-hidden="true" />
				</span>
			</button>

			{(isOpen || isClosing) && (
				<div className={`e__profile-menu ${isOpen ? "is-open" : "is-closing"}`}>
					<div
						className="e__profile-menu__head"
						onClick={() => onTotalExpandedChange(!isTotalExpanded)}
					>
						<button
							className="e__profile-menu__head-label"
							type="button"
							aria-label={isTotalExpanded ? "Collapse total balance history" : "Expand total balance history"}
						>
							<span>Total</span>
						</button>
						<button
							className="e__profile-menu__refresh"
							type="button"
							onPointerDown={event => event.stopPropagation()}
							onClick={(event) => {
								event.stopPropagation();
								onRefresh();
							}}
							disabled={isRefreshing}
							aria-label="Refresh balances"
							title="Refresh balances"
						>
							<span className={isRefreshing ? "e__profile-refresh-icon is-spinning" : "e__profile-refresh-icon"}>
								↻
							</span>
						</button>
						<button
							className="e__profile-menu__head-value"
							type="button"
							aria-label={isTotalExpanded ? "Collapse total balance history" : "Expand total balance history"}
						>
							<strong>{totalLabel}</strong>
							<span className={`e__profile-caret ${isTotalExpanded ? "e__profile-caret--open" : ""}`}>
								<span className="e__dropdown-icon" aria-hidden="true" />
							</span>
						</button>
					</div>

					<div className={`e__balance-history-wrap ${isTotalExpanded ? "is-expanded" : ""}`}>
						<div className="e__balance-history-wrap__inner">
							<BalanceHistoryPlot
								error={balanceHistoryError}
								isColorLine={isHistoryColored}
								isLoading={balanceHistoryLoading}
								onColorLineChange={onHistoryColoredChange}
								onPeriodChange={onHistoryPeriodChange}
								period={balanceHistoryLoadedPeriod}
								points={balanceHistory}
								selectedPeriod={balanceHistoryPeriod}
								total={total}
							/>
						</div>
					</div>

					{error && (
						<div className="e__profile-error">
							{error}
						</div>
					)}

					<div className="e__profile-list">
						{visibleBalances.map(balance => {
							const isNavigable = balance.currency !== "USD" && balance.product_id;
							const isDustBookmarkRow = isDustBookmarkBalance(
								balance,
								appBookmarks,
								getBookmarkedPrice,
								getBalanceUsdValue,
							);
							const rowClassName = [
								"e__profile-row",
								!isNavigable ? "e__profile-row--static" : "",
								isDustBookmarkRow ? "e__profile-row--dust" : "",
							].filter(Boolean).join(" ");
							const rowContent = (
								<BalanceRowContent
									appBookmarks={appBookmarks}
									balance={balance}
									getBookmarkDelta={getBookmarkDelta}
									getBalanceUsdValue={getBalanceUsdValue}
									getBookmarkedPrice={getBookmarkedPrice}
									onClearBookmark={onClearBookmark}
								/>
							);

							return isNavigable ? (
								<a
									key={balance.currency}
									className={rowClassName}
									href={`/${balance.currency}`}
									onClick={event => onCurrencyClick(event, balance.currency)}
								>
									{rowContent}
								</a>
							) : (
								<div
									key={balance.currency}
									className={rowClassName}
								>
									{rowContent}
								</div>
							);
						})}

						{!visibleBalances.length && !error && (
							<div className="e__profile-empty">
								No balances
							</div>
						)}
					</div>
				</div>
			)}
		</>
	);
};

export default BalanceDropdown;
