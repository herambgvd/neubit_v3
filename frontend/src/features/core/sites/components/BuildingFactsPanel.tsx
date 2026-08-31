"use client";

// "Building" tab — the physical and commercial facts about a site.
//
// WHY THIS FORM EXISTS AND WHY IT IS HERE.
// Building Intelligence → Ratings computes an EPI: kWh per square metre per
// year. The kWh is measured; the square metre is not, and nothing on this
// platform could state it. Not `sites`, not `floors`, not the reading store, not
// the gateway. So a rating had no denominator, and the only ways to produce one
// anyway — infer it, default it, borrow a national average — are the fabrication
// the platform's contracts forbid.
//
// It lives HERE, beside the address, for the same reason device placement lives
// on the floor plan (pipeline contract §18): the platform already has ONE place
// where facts about a site are recorded, and a second surface owning half of
// "what this building is" is two answers waiting to disagree. A BI screen asking
// for an area would have been that second surface.
//
// THREE RULES THIS FORM KEEPS:
//   • BLANK IS A VALUE. Clearing a field records "not recorded" — the state
//     Ratings renders as "cannot rate", with a link back here. It is not a
//     validation error and it is not zero. All four fields are sent on every
//     save (PUT, not PATCH) precisely so a blank can be transmitted.
//   • NOTHING IS SUGGESTED. There is no "typical area for a building this size",
//     no default tariff and no inferred occupancy. Every number here is typed by
//     a person, and the panel records who and when.
//   • A TARIFF NEEDS A CURRENCY. The server refuses the pair otherwise rather
//     than assuming rupees; a bare 8.5 is not a price.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { FInput } from "./FormControls";
import { ActionButton } from "@/components/console";
import { apiError } from "@/lib/api";
import sitesApi from "@/lib/api/sites";
import { useAuth } from "@/lib/auth";

/** "" → null. The empty box is the operator saying "I have no reliable number",
 *  which is a fact the store must be able to hold. */
function numOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function Stat({ label, value, sub }: any) {
  return (
    <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">{label}</p>
      <p className="mt-1 font-mono text-[17px] leading-none text-nb-ink">{value}</p>
      {sub && <p className="mt-1 text-[10.5px] text-nb-faint">{sub}</p>}
    </div>
  );
}

export default function BuildingFactsPanel({ site }: any) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const editable = can("sites.update");

  const [area, setArea] = useState<any>("");
  const [tariff, setTariff] = useState<any>("");
  const [currency, setCurrency] = useState<any>("");
  const [occupancy, setOccupancy] = useState<any>("");
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setArea(site.gross_floor_area_sqm ?? "");
    setTariff(site.energy_tariff_per_kwh ?? "");
    setCurrency(site.tariff_currency ?? "");
    setOccupancy(site.occupancy ?? "");
    setErr(null);
    setSaved(false);
  }, [site.site_id, site.building_facts_updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () =>
      sitesApi.setBuildingFacts(site.site_id, {
        // All four, every time. A PATCH could not express "take this back".
        gross_floor_area_sqm: numOrNull(area),
        energy_tariff_per_kwh: numOrNull(tariff),
        tariff_currency: numOrNull(tariff) === null ? null : String(currency || "").trim() || null,
        occupancy: numOrNull(occupancy),
      }),
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["sites"] });
    },
    onError: (e) => {
      setSaved(false);
      setErr(apiError(e, "Could not save the building facts"));
    },
  });

  const areaN = numOrNull(area);
  const tariffN = numOrNull(tariff);
  const missingCurrency = tariffN !== null && !String(currency || "").trim();

  return (
    <div className="grid grid-cols-1 gap-6 px-6 py-5 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
          <FInput
            label="Gross floor area (m²)"
            type="number"
            inputMode="decimal"
            min="0"
            value={area}
            onChange={setArea}
            placeholder="e.g. 18500"
            hint="The denominator of the energy performance index. Leave blank if you do not have a reliable figure — Ratings will say so rather than assume one."
          />
          <FInput
            label="Occupancy (people)"
            type="number"
            inputMode="numeric"
            min="0"
            value={occupancy}
            onChange={setOccupancy}
            placeholder="e.g. 1200"
            hint="Stated, never counted from access-control events — those measure a different thing on a different day."
          />
          <FInput
            label="Energy tariff (per kWh)"
            type="number"
            inputMode="decimal"
            min="0"
            value={tariff}
            onChange={setTariff}
            placeholder="e.g. 8.5"
            hint="Used only to price measured consumption. No tariff is assumed if this is blank."
          />
          <FInput
            label="Tariff currency"
            value={currency}
            onChange={setCurrency}
            placeholder="INR"
            error={missingCurrency ? "A tariff needs a currency" : undefined}
            hint="Stored beside the number rather than assumed — a bare 8.5 is not a price."
          />
        </div>

        {editable ? (
          <div className="flex flex-wrap items-center gap-3">
            <ActionButton onClick={() => save.mutate()} disabled={save.isPending || missingCurrency}>
              {save.isPending ? "Saving…" : "Save building facts"}
            </ActionButton>
            {saved && !save.isPending && (
              <span className="flex items-center gap-1 text-[11.5px] text-nb-good">
                <Icon icon="heroicons:check-circle" className="text-[14px]" /> Saved
              </span>
            )}
            {err && <span className="text-[11.5px] text-nb-crit">{err}</span>}
          </div>
        ) : (
          <p className="text-[11.5px] text-nb-faint">
            You do not hold <span className="font-mono">sites.update</span>, so these values are
            read-only here.
          </p>
        )}

        <div className="flex gap-2.5 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.45)] px-3 py-2.5">
          <Icon
            icon="heroicons:information-circle"
            className="mt-[1px] shrink-0 text-[15px] text-nb-blueb"
          />
          <p className="text-[11px] leading-relaxed text-nb-soft">
            These are <strong className="text-nb-ink">your assertions</strong>, not measurements.
            Nothing on this platform derives them and nothing fills them in. A blank field means
            NOT RECORDED, and Building Intelligence → Ratings will refuse to produce a score rather
            than default, estimate or borrow a figure for it.
          </p>
        </div>
      </div>

      <div className="lg:col-span-2">
        <div className="sticky top-4 space-y-2">
          <Stat
            label="Area on record"
            value={areaN === null ? "not recorded" : `${areaN.toLocaleString()} m²`}
            sub={areaN === null ? "Ratings cannot compute an EPI without this" : "EPI denominator"}
          />
          <Stat
            label="Tariff on record"
            value={
              tariffN === null
                ? "not recorded"
                : `${tariffN} ${String(currency || "").trim() || "?"}/kWh`
            }
          />
          <Stat
            label="Occupancy on record"
            value={numOrNull(occupancy) === null ? "not recorded" : String(numOrNull(occupancy))}
          />
          <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
              Last asserted
            </p>
            <p className="mt-1 text-[12px] text-nb-soft">
              {site.building_facts_updated_at
                ? new Date(site.building_facts_updated_at).toLocaleString()
                : "never"}
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-nb-faint">
              Tracked separately from the site&apos;s own “updated” timestamp, which moves whenever
              anyone edits a phone number. A figure a rating divides by deserves its own provenance.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
