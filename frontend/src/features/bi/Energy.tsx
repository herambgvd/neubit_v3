"use client";

// Building Intelligence → ENERGY & METERING. The `energy` slice of the estate:
// 18 devices / 260 points on this deployment (incomers, solar, UPS, distribution
// boards), all of them real and all of them reporting.
//
// It is CategoryConsole with a filter, not a copy of it — see that file for why
// each panel reads the store it reads.
import CategoryConsole from "./CategoryConsole";

export default function Energy() {
  return <CategoryConsole category="energy" />;
}
