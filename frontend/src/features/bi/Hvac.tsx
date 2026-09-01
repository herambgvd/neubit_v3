"use client";

// Building Intelligence → HVAC & ASSETS. The `hvac` slice of the estate:
// chillers, AC distribution boards and a TFA unit.
//
// Same console as Energy & Metering with a different category — the store makes
// them the same shape, so two implementations could only drift.
import CategoryConsole from "./CategoryConsole";

export default function Hvac() {
  return <CategoryConsole category="hvac" />;
}
