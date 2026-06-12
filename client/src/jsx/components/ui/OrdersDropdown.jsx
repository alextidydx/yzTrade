import React from "react";

import "../../../styles/ui/dropdownShared.scss";
import "../../../styles/ui/ordersDropdown.scss";

import {
	formatOrderValue,
	getCurrencyFromProductId,
} from "../../../utils/homeUtils";

const getFlattenedOrders = (orders) => (
	(Array.isArray(orders) ? orders : []).flatMap(order => (
		Array.isArray(order.bracket_legs) && order.bracket_legs.length
			? order.bracket_legs.map(leg => ({
				...order,
				...leg,
				parent_id: order.id,
				product_id: order.product_id,
			}))
			: [order]
	))
);

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

const OrdersDropdown = ({
	error,
	isClosing,
	isLoading,
	isOpen,
	onCancelOrder,
	onCurrencyClick,
	onToggle,
	orders,
}) => {
	const flatOrders = getFlattenedOrders(orders);
	const groupedOrders = getGroupedOrders(flatOrders);

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
				{flatOrders.length > 0 && (
					<strong>{flatOrders.length}</strong>
				)}
			</button>

			{(isOpen || isClosing) && (
				<div className={`e__orders-menu ${isOpen ? "is-open" : "is-closing"}`}>
					{error && (
						<div className="e__orders-menu__error">
							{error}
						</div>
					)}

					{isLoading && !flatOrders.length && (
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
								const price = Number(order.price);
								const totalValue = formatOrderValue(order.total_value, order.amount, price, order.quote_size);

								return (
									<div className="e__orders-row" key={order.id || `${order.product_id}-${order.side}-${order.price}`}>
										<span className={`e__orders-row__badge e__orders-row__badge--${side}`}>
											{side.toUpperCase()}
										</span>
										<span className="e__orders-row__price">
											{totalValue}
										</span>
										<button
											className="e__orders-row__cancel"
											type="button"
											onClick={event => onCancelOrder(order, event)}
											aria-label={`Cancel ${side} order`}
										>
											<span aria-hidden="true" />
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
			)}
		</div>
	);
};

export default OrdersDropdown;
