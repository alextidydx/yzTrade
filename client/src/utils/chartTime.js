import { CHART_TIME_ZONE } from "./homeConstants";

const chartTimeFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: CHART_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

const chartTimeCache = new Map();

const getPart = (parts, type) => (
	Number(parts.find(part => part.type === type)?.value)
);

export const toChartTime = (time) => {
	const timestamp = Number(time);

	if (!Number.isFinite(timestamp)) return time;
	if (chartTimeCache.has(timestamp)) return chartTimeCache.get(timestamp);

	const date = new Date(timestamp * 1000);
	const parts = chartTimeFormatter.formatToParts(date);
	const shiftedTimestamp = Date.UTC(
		getPart(parts, "year"),
		getPart(parts, "month") - 1,
		getPart(parts, "day"),
		getPart(parts, "hour"),
		getPart(parts, "minute"),
		getPart(parts, "second"),
		date.getUTCMilliseconds(),
	) / 1000;

	chartTimeCache.set(timestamp, shiftedTimestamp);

	return shiftedTimestamp;
};

export const toChartPoint = (point) => ({
	...point,
	time: toChartTime(point.time),
});

export const toChartData = (data) => data.map(toChartPoint);

const chartCrosshairTimeFormatter = new Intl.DateTimeFormat("en-US", {
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
	timeZone: "UTC",
});

export const formatChartCrosshairTime = (time) => {
	let timestamp;

	if (time != null && typeof time === "object") {
		timestamp = Date.UTC(
			Number(time.year),
			Number(time.month) - 1,
			Number(time.day),
			Number(time.hour) || 0,
			Number(time.minute) || 0,
			Number(time.second) || 0,
		) / 1000;
	} else {
		timestamp = Number(time);
	}

	if (!Number.isFinite(timestamp)) return "";

	return chartCrosshairTimeFormatter
		.format(new Date(timestamp * 1000))
		.replace(/^24:/, "00:");
};
