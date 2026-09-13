/**
 * Two derivations the alarm screens share.
 *
 * `stepPhase` used to be a pair of booleans recomputed in three components, and
 * the two of them were tested in a different ORDER in each — one asked "done?"
 * first, another "current?". That is only safe while both can never be true at
 * once, which is a property of the arithmetic and not of the markup. Asking once
 * is what makes it safe; these tests pin what the single answer is.
 *
 * `slaFor`'s deadline is the other: an explicit deadline from the backend beats
 * one derived from sla_hours, because the explicit one is the only version that
 * knows about a pause or a deadline somebody moved.
 */
import { describe, expect, it } from "vitest";

import { slaFor, stepPhase, type Incident } from "./lib";

describe("stepPhase", () => {
  it("splits a procedure at the step being worked", () => {
    // Four steps, the third (index 2) is current.
    expect([0, 1, 2, 3].map((i) => stepPhase(i, 2))).toEqual(["done", "done", "current", "pending"]);
  });

  it("calls nothing done when no step is current", () => {
    // `at` is -1 when the incident's state is not in the SOP's step list at all.
    // Reading that as "every step is behind us" would render a procedure nobody
    // has started as a completed one.
    expect([0, 1, 2].map((i) => stepPhase(i, -1))).toEqual(["pending", "pending", "pending"]);
  });

  it("marks the first step current, not done, at the start", () => {
    expect(stepPhase(0, 0)).toBe("current");
  });
});

const HOUR = 3_600_000;
const CREATED = "2026-01-01T00:00:00.000Z";
const base = { status: "open", created_at: CREATED } as unknown as Incident;

describe("slaFor deadline", () => {
  it("prefers the backend's own deadline over one derived from sla_hours", () => {
    const moved = new Date(Date.parse(CREATED) + 9 * HOUR).toISOString();
    const it = { ...base, sla_hours: 2, sla_deadline: moved } as Incident;
    expect(slaFor(it, Date.parse(CREATED))?.deadline).toBe(Date.parse(moved));
  });

  it("derives one from sla_hours when the backend sends no deadline", () => {
    const it = { ...base, sla_hours: 2 } as Incident;
    expect(slaFor(it, Date.parse(CREATED))?.deadline).toBe(Date.parse(CREATED) + 2 * HOUR);
  });

  it("reports no SLA rather than a bogus one when there is nothing to derive from", () => {
    expect(slaFor(base, Date.now())).toBeNull();
    expect(slaFor({ ...base, sla_hours: 2, created_at: null } as unknown as Incident, Date.now())).toBeNull();
    expect(slaFor({ ...base, sla_deadline: "not a date" } as unknown as Incident, Date.now())).toBeNull();
  });
});
