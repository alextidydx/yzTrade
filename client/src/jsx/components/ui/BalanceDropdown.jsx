import React from "react";

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
	balances,
	error,
	getBookmarkDelta,
	isClosing,
	isLoading,
	isOpen,
	onCurrencyClick,
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
					<div className="e__profile-menu__head">
						<span>Total</span>
						<strong>{totalLabel}</strong>
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
