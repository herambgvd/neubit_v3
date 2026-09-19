/**
 * GATE 6's one rule: which findings are WORK, and which are only readings.
 *
 * The expensive mistake here is not a missing ticket — it is a ticket raised
 * about a chiller that is running perfectly. `status: "ok"` means the metric
 * COMPUTED; the registry carries no pass mark, so a healthy ΔT is `ok` and must
 * never reach an operator as something to act on.
 */
import { describe, expect, it } from "vitest";

import { actionable, alertFindings, isActionable, keysOf, splitByWork, type Finding } from "./findings";

const work = (key: string) => ({
  source_key: key,
  name: "n",
  description: "d",
  site_id: "s1",
  trigger_data: {},
});

const metric = (over: Partial<Finding> = {}): Finding => ({
  source_key: "bi:equipment:e1:metric:chw_delta_t_in_band",
  kind: "equipment_metric",
  status: "ok",
  equipment_id: "e1",
  equipment_tag: "CH-1",
  title: "CHW ΔT in band",
  summary: null,
  evidence: null,
  work: work("bi:equipment:e1:metric:chw_delta_t_in_band"),
  ...over,
});

const fault = (over: Partial<Finding> = {}): Finding =>
  metric({
    source_key: "bi:equipment:e1:slot:chws",
    kind: "data_fault",
    status: "silent",
    title: "CHW supply has gone quiet",
    work: work("bi:equipment:e1:slot:chws"),
    ...over,
  });

describe("what counts as work", () => {
  it("never offers work about a metric that computed", () => {
    // The whole point. `ok` is not a pass mark, and treating it as a fault would
    // invent one.
    expect(isActionable(metric({ status: "ok" }))).toBe(false);
    expect(actionable([metric({ status: "ok" })])).toEqual([]);
  });

  it("counts a refusal, because the reason names a real task", () => {
    expect(isActionable(metric({ status: "missing_fact" }))).toBe(true);
    expect(isActionable(metric({ status: "slot_unbound" }))).toBe(true);
  });

  it("counts a bound sensor that stopped", () => {
    expect(isActionable(fault())).toBe(true);
  });

  it("counts an alert nobody has acknowledged, and not one somebody has", () => {
    expect(isActionable(metric({ kind: "alert", status: "open" }))).toBe(true);
    expect(isActionable(metric({ kind: "alert", status: "acked" }))).toBe(false);
  });

  it("puts a fault in the data before a refusal, and the gateway's own last", () => {
    const list = actionable([
      metric({ kind: "alert", status: "open", source_key: "bi:iot_alert:a1" }),
      metric({ status: "missing_fact" }),
      fault(),
    ]);
    expect(list.map((f) => f.kind)).toEqual(["data_fault", "equipment_metric", "alert"]);
  });
});

describe("an alert becomes a finding", () => {
  it("only when the store gave it a key and a body", () => {
    const out = alertFindings([
      { alert_id: "a1", ts: "t", source_key: "bi:iot_alert:a1", work: work("bi:iot_alert:a1"), acked: false },
      // Older than the wire change: no key, no body. Inventing one here would let
      // two consoles disagree about what a key means.
      { alert_id: "a2", ts: "t" },
    ]);
    expect(out.map((f) => f.source_key)).toEqual(["bi:iot_alert:a1"]);
    expect(out[0].status).toBe("open");
  });

  it("carries the acknowledgement through, so an acked alert is not work", () => {
    const [f] = alertFindings([
      { alert_id: "a1", ts: "t", source_key: "k:1", work: work("k:1"), acked: true },
    ]);
    expect(f.status).toBe("acked");
    expect(isActionable(f)).toBe(false);
  });
});

describe("splitting by open work", () => {
  it("is not answered at all until the lookup has answered", () => {
    // A null split makes the caller say "not known". Counting every finding as
    // unattended because nobody asked would invent a backlog.
    expect(splitByWork([fault()], undefined)).toBeNull();
    expect(splitByWork([fault()], null)).toBeNull();
  });

  it("separates what is already being worked on from what is not", () => {
    const a = fault();
    const b = metric({ status: "missing_fact" });
    const split = splitByWork([a, b], {
      [a.source_key]: {
        instance_id: "i1",
        name: "INC-1",
        sop_name: "General alarm",
        status: "open",
        priority: "normal",
        current_state_name: "Triage",
        assigned_to: null,
        created_at: "t",
      },
    });
    expect(split?.withWork.map((w) => w.finding.source_key)).toEqual([a.source_key]);
    expect(split?.withoutWork.map((f) => f.source_key)).toEqual([b.source_key]);
  });
});

describe("the keys asked about", () => {
  it("asks for each key once", () => {
    const f = fault();
    expect(keysOf([f, f, metric({ status: "missing_fact" })])).toEqual([
      f.source_key,
      "bi:equipment:e1:metric:chw_delta_t_in_band",
    ]);
  });

  it("stops at the 500 the route accepts, rather than sending a 422", () => {
    const many = Array.from({ length: 600 }, (_, i) => fault({ source_key: `k:${i}` }));
    expect(keysOf(many)).toHaveLength(500);
  });
});
