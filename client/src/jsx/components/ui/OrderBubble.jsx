import React from "react";

import "../../../styles/ui/orderBubble.scss";

import { ORDER_FRACTIONS } from "../../../utils/homeConstants";

const OrderBubble = ({
	amountUnitLabel,
	isClosing,
	isOrderTypeMenuOpen,
	messageIsSuccess,
	onAmountBlur,
	onAmountChange,
	onAmountKeyDown,
	onCancel,
	onFractionChange,
	onFractionCommit,
	onFractionPreset,
	onOrderTypeMenuToggle,
	onPriceFieldChange,
	onPriceFieldFocus,
	onSellStopOrderTypeChange,
	onSideChange,
	onSubmit,
	onTypeChange,
	onUnitToggle,
	orderTicket,
	orderTicketRef,
	orderTicketStyle,
	previewBaseAmountLabel,
	previewBracketLossLabel,
	previewBracketProfitLabel,
	previewFeeLabel,
	previewQuoteSizeLabel,
	previewTotalLabel,
	sliderDisabled,
	sliderFraction,
	submitLabel,
	ticketAvailableLabel,
	ticketMarketPriceLabel,
	ticketOrderType,
	ticketPrimaryOrderType,
	ticketSide,
	visibleError,
}) => {
	if (!orderTicket) return null;

	const isSell = ticketSide === "SELL";
	const showLimitPrice = ticketOrderType !== "MARKET" && ticketOrderType !== "BRACKET";
	const showStopPrice = ticketOrderType === "STOP_LIMIT";
	const showBracketPrices = ticketOrderType === "BRACKET";

	return (
		<div
			className={`e__order-ticket ${isClosing ? "is-closing" : "is-open"}`}
			ref={orderTicketRef}
			style={orderTicketStyle}
		>
			<div className="e__order-ticket__side">
				<button
					className={ticketSide === "BUY" ? "e__order-ticket__buy is-active" : "e__order-ticket__buy"}
					type="button"
					onClick={() => onSideChange("BUY")}
				>
					BUY
				</button>
				<button
					className={isSell ? "e__order-ticket__sell is-active" : "e__order-ticket__sell"}
					type="button"
					onClick={() => onSideChange("SELL")}
				>
					SELL
				</button>
			</div>

			<div className="e__order-ticket__types">
				<button
					className={ticketPrimaryOrderType === "LIMIT" ? "is-active" : ""}
					type="button"
					onClick={() => onTypeChange("LIMIT")}
				>
					Limit
				</button>
				<button
					className={ticketPrimaryOrderType === "MARKET" ? "is-active" : ""}
					type="button"
					onClick={() => onTypeChange("MARKET")}
				>
					Market
				</button>
				{isSell ? (
					<div className="e__order-ticket__type-menu-wrap">
						<button
							className={ticketPrimaryOrderType === "STOP" ? "is-active e__order-ticket__type-select" : "e__order-ticket__type-select"}
							type="button"
							onClick={onOrderTypeMenuToggle}
						>
							{ticketOrderType === "BRACKET" ? "Bracket" : "Stop limit"}
							<span className="e__order-ticket__type-caret" aria-hidden="true" />
						</button>
						{isOrderTypeMenuOpen && (
							<div className="e__order-ticket__type-menu">
								<button
									type="button"
									className={ticketOrderType === "STOP_LIMIT" ? "is-active" : ""}
									onClick={() => onSellStopOrderTypeChange("STOP_LIMIT")}
								>
									Stop limit
								</button>
								<button
									type="button"
									className={ticketOrderType === "BRACKET" ? "is-active" : ""}
									onClick={() => onSellStopOrderTypeChange("BRACKET")}
								>
									Bracket
								</button>
							</div>
						)}
					</div>
				) : (
					<button
						className={ticketPrimaryOrderType === "STOP" ? "is-active" : ""}
						type="button"
						onClick={() => onTypeChange("STOP_LIMIT")}
					>
						Stop
					</button>
				)}
			</div>

			<div className="e__order-ticket__balance">
				<span>Available</span>
				<strong>{ticketAvailableLabel}</strong>
			</div>

			{ticketMarketPriceLabel !== null && (
				<div className="e__order-ticket__balance">
					<span>Price</span>
					<strong>{ticketMarketPriceLabel}</strong>
				</div>
			)}

			{showLimitPrice && (
				<label>
					<span>Price</span>
					<div className="e__order-ticket__input-wrap">
						<input
							value={orderTicket.price}
							inputMode="decimal"
							pattern="[0-9]*[.,]?[0-9]*"
							onChange={event => onPriceFieldChange("price", event.target.value)}
							onFocus={() => onPriceFieldFocus("price")}
						/>
						<strong>USD</strong>
					</div>
				</label>
			)}

			{showStopPrice && (
				<label>
					<span>Stop</span>
					<div className="e__order-ticket__input-wrap">
						<input
							value={orderTicket.stopPrice}
							inputMode="decimal"
							pattern="[0-9]*[.,]?[0-9]*"
							onChange={event => onPriceFieldChange("stopPrice", event.target.value)}
							onFocus={() => onPriceFieldFocus("stopPrice")}
						/>
						<strong>USD</strong>
					</div>
				</label>
			)}

			{showBracketPrices && (
				<>
					<label>
						<span>TP</span>
						<div className="e__order-ticket__input-wrap">
							<input
								value={orderTicket.takeProfitPrice}
								inputMode="decimal"
								pattern="[0-9]*[.,]?[0-9]*"
								onChange={event => onPriceFieldChange("takeProfitPrice", event.target.value)}
								onFocus={() => onPriceFieldFocus("takeProfitPrice")}
							/>
							<strong>USD</strong>
						</div>
					</label>
					<label>
						<span>SL</span>
						<div className="e__order-ticket__input-wrap">
							<input
								value={orderTicket.stopLossPrice}
								inputMode="decimal"
								pattern="[0-9]*[.,]?[0-9]*"
								onChange={event => onPriceFieldChange("stopLossPrice", event.target.value)}
								onFocus={() => onPriceFieldFocus("stopLossPrice")}
							/>
							<strong>USD</strong>
						</div>
					</label>
				</>
			)}

			<label>
				<span>Amount</span>
				<div className="e__order-ticket__input-wrap">
					<input
						value={Number(orderTicket.amount) === 0 ? "" : orderTicket.amount}
						placeholder="0"
						inputMode="decimal"
						pattern="[0-9]*[.,]?[0-9]*"
						onChange={event => onAmountChange(event.target.value)}
						onBlur={onAmountBlur}
						onKeyDown={onAmountKeyDown}
					/>
					<button
						className="e__order-ticket__unit"
						type="button"
						onClick={onUnitToggle}
						title="Switch amount unit"
					>
						<span className="e__order-ticket__unit-icon" aria-hidden="true">{"\u21c4"}</span>
						<span>{amountUnitLabel}</span>
					</button>
				</div>
			</label>

			<input
				className="e__order-ticket__slider"
				type="range"
				min="0"
				max="1"
				step="0.01"
				value={Number.isFinite(Number(sliderFraction)) ? sliderFraction : 0}
				disabled={sliderDisabled}
				onChange={event => onFractionChange(Number(event.target.value))}
				onPointerUp={() => onFractionCommit?.()}
				onTouchEnd={() => onFractionCommit?.()}
			/>

			<div className="e__order-ticket__fractions">
				{ORDER_FRACTIONS.map(item => (
					<button
						key={item.label}
						type="button"
						onClick={() => (onFractionPreset || onFractionChange)(item.value)}
					>
						{item.label}
					</button>
				))}
			</div>

			<div className="e__order-ticket__summary">
				<div>
					<span>Total</span>
					<strong>{previewTotalLabel}</strong>
				</div>
				<div>
					<span>Amount</span>
					<strong>{previewBaseAmountLabel}</strong>
				</div>
				<div>
					<span>Fee</span>
					<strong>{previewFeeLabel}</strong>
				</div>
				{previewQuoteSizeLabel !== null && (
					<div>
						<span>Value</span>
						<strong>{previewQuoteSizeLabel}</strong>
					</div>
				)}
				{previewBracketProfitLabel !== null && (
					<div>
						<span>Profit</span>
						<strong>{previewBracketProfitLabel}</strong>
					</div>
				)}
				{previewBracketLossLabel !== null && (
					<div>
						<span>Loss</span>
						<strong>{previewBracketLossLabel}</strong>
					</div>
				)}
			</div>

			<div
				className={messageIsSuccess
					? "e__order-ticket__message e__order-ticket__success"
					: "e__order-ticket__message e__order-ticket__error"}
				aria-live="polite"
			>
				{visibleError ? String(visibleError) : "\u00a0"}
			</div>

			<div className="e__order-ticket__actions">
				<button
					className={isSell ? "e__order-ticket__submit e__order-ticket__submit--sell" : "e__order-ticket__submit e__order-ticket__submit--buy"}
					type="button"
					disabled={orderTicket.isSubmitting || orderTicket.isPreviewLoading}
					onClick={onSubmit}
				>
					{submitLabel}
				</button>
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</div>
	);
};

export default OrderBubble;
