import "../../../styles/ui/dropdownShared.scss";
import "../../../styles/ui/ordersDropdown.scss";

import {
	formatBalanceAmount,
	formatOrderDisplayTotal,
	formatUsdFullValue,
	getCurrencyFromProductId,
	getOrderDisplayAmount,
	getOrderDisplayTotalUsd,
	getOrderFilledPercent,
} from "../../../utils/homeUtils";

const getListedOrders = (orders) => (
	(Array.isArray(orders) ? orders : []).filter((order) => (
		String(order?.order_type || "").toUpperCase() !== "MARKET"
	))
);

const getOrderTypeLabel = (order) => {
	const orderType = String(order?.order_type || "").toUpperCase();

	if (orderType === "TRAILING_LIMIT") return "TRAILING LIMIT";
	if (orderType === "TRAILING_MARKET" || orderType === "TRAILING") return "TRAILING MARKET";

	return orderType === "BRACKET" ? orderType : "";
};

const getGroupedOrders = (orders) => {
	const ordersByCurrency = orders.reduce((groups, order) => {
		const currency = getCurrencyFromProductId(order.product_id);

		if (!groups.has(currency)) {
			groups.set(currency, []);
		}

		groups.get(currency).push(order);

		return groups;
	}, new Map());

	return [...ordersByCurrency.entries()]
		.sort(([currencyA], [currencyB]) => currencyA.localeCompare(currencyB))
		.map(([currency, groupedOrdersForCurrency]) => ({
			currency,
			orders: groupedOrdersForCurrency.sort((a, b) => (
				String(a.side).localeCompare(String(b.side))
				|| Number(a.price) - Number(b.price)
			)),
		}));
};

const getSideTotalsUsd = (orders) => (
	(Array.isArray(orders) ? orders : []).reduce((totals, order) => {
		const value = getOrderDisplayTotalUsd(order);

		if (!Number.isFinite(value) || value <= 0) return totals;

		const side = String(order?.side || "").toLowerCase() === "sell" ? "sell" : "buy";
		totals[side] += value;

		return totals;
	}, { buy: 0, sell: 0 })
);

const formatSideTotal = (value) => (
	Number.isFinite(value) && value > 0 ? formatUsdFullValue(value) : "$0.00"
);

const getSellOrdersMarkUsd = (orders, getSellOrderCoinsUsdValue) => (
	(Array.isArray(orders) ? orders : []).reduce((sum, order) => {
		if (String(order?.side || "").toLowerCase() !== "sell") return sum;

		const value = Number(getSellOrderCoinsUsdValue?.(order));

		if (!Number.isFinite(value) || value <= 0) return sum;

		return sum + value;
	}, 0)
);

const OrdersDropdown = ({
	error,
	getSellOrderCoinsUsdValue,
	isClosing,
	isLoading,
	isOpen,
	onCancelOrder,
	onCurrencyClick,
	onToggle,
	orders,
}) => {
	const listedOrders = getListedOrders(orders);
	const groupedOrders = getGroupedOrders(listedOrders);
	const sideTotals = getSideTotalsUsd(listedOrders);
	const showTotals = listedOrders.length > 0;
	const sellMarkUsd = getSellOrdersMarkUsd(listedOrders, getSellOrderCoinsUsdValue);
	const sellDeltaUsd = sideTotals.sell - sellMarkUsd;
	const sellDeltaPercent = sellMarkUsd > 0 ? (sellDeltaUsd / sellMarkUsd) * 100 : NaN;
	const sellDeltaDollars = Math.round(sellDeltaUsd);
	const sellDeltaLabel = (
		Number.isFinite(sellDeltaUsd)
		&& Number.isFinite(sellDeltaPercent)
		&& sellMarkUsd > 0
		&& sideTotals.sell > 0
	)
		? `(${sellDeltaDollars >= 0 ? "+" : "-"}$${Math.abs(sellDeltaDollars).toLocaleString()} | ${sellDeltaPercent >= 0 ? "+" : "-"}${Math.abs(sellDeltaPercent).toFixed(1)}%)`
		: "";

	return (
		<div className="e__orders-menu-wrap">
			<button
				className="e__orders-button"
				type="button"
				onClick={onToggle}
				aria-label="Open orders"
				title="Open orders"
			>
				<span className="e__orders-button__icon" aria-hidden="true">
					<span />
					<span />
					<span />
				</span>
				{listedOrders.length > 0 && (
					<strong>{listedOrders.length}</strong>
				)}
			</button>

			{(isOpen || isClosing) && (
				<div className={`e__orders-menu ${isOpen ? "is-open" : "is-closing"}`}>
					<div className="e__orders-menu__body">
						{error && (
							<div className="e__orders-menu__error">
								{error}
							</div>
						)}

						{isLoading && !listedOrders.length && (
							<div className="e__orders-menu__empty">
								Loading
							</div>
						)}

						{groupedOrders.map(group => (
							<div className="e__orders-group" key={group.currency}>
								<a
									className="e__orders-group__currency"
									href={`/${group.currency}`}
									onClick={event => onCurrencyClick(event, group.currency)}
								>
									<span>{group.currency}</span>
									<strong>{group.orders.length}</strong>
								</a>

								{group.orders.map(order => {
									const side = String(order.side).toLowerCase() === "sell" ? "sell" : "buy";
									const totalValue = formatOrderDisplayTotal(order);
									const displayAmount = getOrderDisplayAmount(order);
									const amountLabel = Number.isFinite(displayAmount) && displayAmount > 0
										? `${formatBalanceAmount(displayAmount)} ${group.currency}`
										: "";
									const filledPercent = getOrderFilledPercent(order);
									const originalUsd = Number(order.original_value_usd);
									const usedUsd = Number(order.used_value_usd);
									const isTrackedBuy = (
										side === "buy"
										&& Number.isFinite(originalUsd)
										&& originalUsd > 0
										&& Number.isFinite(usedUsd)
									);
									const filledLabel = isTrackedBuy
										? `${Math.round((usedUsd / originalUsd) * 100)}%`
										: (
											Number.isFinite(filledPercent)
												? `${Math.round(filledPercent)}%`
												: ""
										);
									const orderTypeLabel = getOrderTypeLabel(order);
									const isError = String(order.status || "").toUpperCase() === "ERROR";

									return (
										<div className="e__orders-row" key={order.original_id}>
											<span className={`e__orders-row__badge e__orders-row__badge--${isError ? "error" : side}`}>
												{isError ? "ERROR" : side.toUpperCase()}
												{orderTypeLabel && (
													<small className="e__orders-row__type">{orderTypeLabel}</small>
												)}
											</span>
											<span className="e__orders-row__price">
												<strong>{totalValue}</strong>
												{amountLabel && (
													<small>{amountLabel}</small>
												)}
											</span>
											<span className="e__orders-row__filled">
												{filledLabel}
											</span>
											<button
												className="e__orders-row__cancel"
												type="button"
												onClick={event => onCancelOrder(order, event)}
												aria-label={`Cancel ${side} order`}
											>
												<svg viewBox="-8 -8 16 16" aria-hidden="true">
													<circle r={7} />
													<path d="M -2.24 -2.24 L 2.24 2.24 M 2.24 -2.24 L -2.24 2.24" />
												</svg>
											</button>
										</div>
									);
								})}
							</div>
						))}

						{!isLoading && !groupedOrders.length && !error && (
							<div className="e__orders-menu__empty">
								No open orders
							</div>
						)}
					</div>

					{showTotals && (
						<div className="e__orders-menu__totals" aria-label="Open order totals">
							<span className="e__orders-menu__totals-buy">
								BUY {formatSideTotal(sideTotals.buy)}
							</span>
							<span className="e__orders-menu__totals-sell">
								SELL {formatSideTotal(sideTotals.sell)}
								{sellDeltaLabel && (
									<small
										className={
											sellDeltaUsd >= 0
												? "e__orders-menu__totals-delta e__orders-menu__totals-delta--up"
												: "e__orders-menu__totals-delta e__orders-menu__totals-delta--down"
										}
									>
										{` ${sellDeltaLabel}`}
									</small>
								)}
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
};

export default OrdersDropdown;
