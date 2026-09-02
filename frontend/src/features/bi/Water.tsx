"use client";

// Building Intelligence → WATER. The `water` slice of the estate: 2 devices /
// 10 points on this deployment — a sump pump (6) and a flow meter (4), both
// reporting.
//
// It exists because that data does. Portfolio has shown the category since it
// could, with "no console yet" on its card and no destination, which was the
// honest state while there was nowhere to send anyone. There is somewhere now,
// and nothing about this screen is filled in: IAQ, Ratings and Insights stay
// SOON because they have no points behind them, and this one is not evidence
// that they should not.
//
// Same console as Energy & Metering and HVAC & Assets with a different category.
// The store makes all three the same shape — devices grouped from `points`, the
// points of a device, the series of a point — so a second implementation could
// only drift. Read CategoryConsole for why each panel reads what it reads,
// including why no panel here names a unit: `points.unit` is NULL for every IoT
// point because the source payloads carry none, and a flow meter's readings are
// shown as the numbers they are rather than as litres somebody assumed.
import CategoryConsole from "./CategoryConsole";

export default function Water() {
  return <CategoryConsole category="water" />;
}
