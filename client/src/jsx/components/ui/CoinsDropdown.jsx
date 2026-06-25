import React from "react";

import "../../../styles/ui/dropdownShared.scss";
import "../../../styles/ui/coinsDropdown.scss";

import {
	formatCompactPrice,
	formatSignedPercent,
} from "../../../utils/homeUtils";

const CoinsDropdown = ({
	baseCurrency,
	isClosing,
	isHovered,
	isLoading,
	isOpen,
	monitorError,
	onBaseCurrencyChange,
	onHoverChange,
	onOpen,
	onTickerClick,
	onToggle,
	tickers,
}) => {
	const filter = String(baseCurrency || "").trim().toUpperCase();
	const hasExactTickerMatch = tickers.some(ticker => (
		String(ticker.currency || "").toUpperCase() === filter
	));
	const filteredTickers = filter && !hasExactTickerMatch
		? tickers.filter(ticker => String(ticker.currency || "").toUpperCase().includes(filter))
		: tickers;

	return (
		<div
			className={`e__currency-picker ${isHovered ? "is-hovered" : ""} ${isOpen ? "is-open" : ""}`}
			onPointerEnter={() => onHoverChange(true)}
			onPointerLeave={() => onHoverChange(false)}
		>
			<input
				value={baseCurrency}
				onChange={event => onBaseCurrencyChange(event.target.value.toUpperCase())}
				onFocus={onOpen}
				disabled={isLoading}
				aria-label="Base currency"
			/>
			<button
				className={`e__currency-picker__button ${isOpen ? "e__currency-picker__button--open" : ""}`}
				type="button"
				disabled={isLoading}
				onClick={onToggle}
				aria-label="Open monitor tickers"
				title={monitorError || "Monitor tickers refresh every 1 minute"}
			>
				<span className="e__dropdown-icon" aria-hidden="true" />
			</button>
			{(isOpen || isClosing) && (
				<div className={`e__currency-picker__menu ${isOpen ? "is-open" : "is-closing"}`}>
					{filteredTickers.map(ticker => {
						const change = Number(ticker.change_24h);
						const changeClass = Number.isFinite(change)
							? change >= 0
								? "e__currency-picker__change--up"
								: "e__currency-picker__change--down"
							: "";

						return (
							<a
								key={ticker.currency}
								className="e__currency-picker__option"
								href={`/${ticker.currency}`}
								onClick={event => onTickerClick(event, ticker.currency)}
							>
								<span>{ticker.currency}</span>
								<span className="e__currency-picker__price">
									{formatCompactPrice(ticker.price)}
								</span>
								<strong className={changeClass}>
									{formatSignedPercent(change)}
								</strong>
							</a>
						);
					})}
				</div>
			)}
		</div>
	);
};

export default CoinsDropdown;
