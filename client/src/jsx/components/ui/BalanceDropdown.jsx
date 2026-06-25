import React, { useState } from "react";

import "../../../styles/ui/dropdownShared.scss";
import "../../../styles/ui/balanceDropdown.scss";

import {
	formatBalanceAmount,
	formatUsdCents,
} from "../../../utils/homeUtils";

const getVisibleBalances = (balances) => (
	(Array.isArray(balances) ? balances : []).filter(balance => {
		const isCashBalance = balance.currency === "USD" || balance.currency === "USDC";
		const balanceValue = isCashBalance
			? Number(balance.total)
			: Number(balance.usd_value);

		return Number.isFinite(balanceValue) && balanceValue >= 0.99;
	})
);

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
	onPeriodChange,
	period,
	points,
	total,
}) => {
	const [activeIndex, setActiveIndex] = useState(null);
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

	const activePoint = Number.isInteger(activeIndex) ? plotPoints[activeIndex] : null;

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
						className={period === item.key ? "is-active" : ""}
						type="button"
						onClick={() => onPeriodChange(item.key)}
					>
						{item.label}
					</button>
				))}
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
					<path className="e__balance-history__line" d={linePath} />

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

const BalanceRowContent = ({ balance, getBookmarkDelta }) => {
	const isCashBalance = balance.currency === "USD" || balance.currency === "USDC";
	const balanceValue = isCashBalance
		? balance.total
		: balance.usd_value;
	const availableBalance = Number(balance.available);
	const bookmarkDelta = getBookmarkDelta(balance);

	return (
		<>
			<span className="e__profile-row__currency">{balance.currency}</span>
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
					<small className={`e__profile-row__bookmark ${bookmarkDelta.isPositive ? "e__profile-row__bookmark--up" : "e__profile-row__bookmark--down"}`}>
						{bookmarkDelta.label}
					</small>
				)}
			</span>
		</>
	);
};

const BalanceDropdown = ({
	balanceHistory,
	balanceHistoryError,
	balanceHistoryPeriod,
	balances,
	error,
	getBookmarkDelta,
	isClosing,
	isLoading,
	isOpen,
	isTotalExpanded,
	onCurrencyClick,
	onHistoryPeriodChange,
	onTotalExpandedChange,
	onToggle,
	total,
}) => {
	const visibleBalances = getVisibleBalances(balances);
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
					<button
						className="e__profile-menu__head"
						type="button"
						onClick={() => onTotalExpandedChange(!isTotalExpanded)}
					>
						<span>Total</span>
						<strong>{totalLabel}</strong>
						<span className={`e__profile-caret ${isTotalExpanded ? "e__profile-caret--open" : ""}`}>
							<span className="e__dropdown-icon" aria-hidden="true" />
						</span>
					</button>

					<div className={`e__balance-history-wrap ${isTotalExpanded ? "is-expanded" : ""}`}>
						<div className="e__balance-history-wrap__inner">
							<BalanceHistoryPlot
								error={balanceHistoryError}
								onPeriodChange={onHistoryPeriodChange}
								period={balanceHistoryPeriod}
								points={balanceHistory}
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
							const rowContent = (
								<BalanceRowContent
									balance={balance}
									getBookmarkDelta={getBookmarkDelta}
								/>
							);

							return isNavigable ? (
								<a
									key={balance.currency}
									className="e__profile-row"
									href={`/${balance.currency}`}
									onClick={event => onCurrencyClick(event, balance.currency)}
								>
									{rowContent}
								</a>
							) : (
								<div
									key={balance.currency}
									className="e__profile-row e__profile-row--static"
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
