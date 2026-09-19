"use client";

// Building Intelligence → Setup → BUILDING FACTS — the physical and commercial
// facts about one building: gross floor area, tariff (+ time-of-use slabs),
// occupancy and grid emission factors.
//
// WHY THIS FORM EXISTS. Ratings computes an EPI: kWh per square metre per year.
// The kWh is measured; the square metre is not, and nothing on this platform
// could state it. So a rating had no denominator, and the only ways to produce
// one anyway — infer it, default it, borrow a national average — are the
// fabrication the platform's contracts forbid.
//
// WHY IT IS IN SETUP. Nothing in Sites, Floors, Zones or the VMS reads one of
// these numbers; they are BI inputs, so the FORM is BI's. The facts are still
// STORED on the site (`sites.update` writes them, `sites.read` reads the
// record), which is why this panel gates on those keys rather than on
// `bi.manage`: a control is offered exactly when the endpoint behind it would
// accept it. Ratings DISPLAYS what it divides by and links here.
//
// THREE RULES THIS FORM KEEPS:
//   • BLANK IS A VALUE. Clearing a field records "not recorded" — the state
//     Ratings renders as "cannot rate". It is not a validation error and it is
//     not zero. All four fields are sent on every save (PUT, not PATCH)
//     precisely so a blank can be transmitted.
//   • NOTHING IS SUGGESTED. No typical area, no default tariff, no inferred
//     occupancy. Every number is typed by a person; the panel records when.
//   • A TARIFF NEEDS A CURRENCY. The server refuses the pair otherwise rather
//     than assuming rupees; a bare 8.5 is not a price.
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { FInput } from "@/features/core/sites/components/FormControls";
import { ActionButton } from "@/components/console";
import { apiError } from "@/lib/api";
import sitesApi from "@/lib/api/sites";
import type { SitePublic } from "@/lib/types";
import { useAuth } from "@/lib/auth";

import Reason from "../Reason";

import EmissionFactorsEditor from "./EmissionFactorsEditor";
import TariffSlabsEditor from "./TariffSlabsEditor";

/** "" → null. The empty box is the operator saying "I have no reliable number",
 *  which is a fact the store must be able to hold. */
function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function Stat({ label, value, sub }: Readonly<{ label: ReactNode; value: ReactNode; sub?: ReactNode }>) {
  return (
    <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">{label}</p>
      <p className="mt-1 font-mono text-[17px] leading-none text-nb-ink">{value}</p>
      {sub && <p className="mt-1 text-[10.5px] text-nb-faint">{sub}</p>}
    </div>
  );
}

export default function BuildingFactsPanel({ site }: Readonly<{ site: SitePublic }>) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const editable = can("sites.update");

  // Raw field text once edited; the recorded number until then ("" = not recorded).
  const [area, setArea] = useState<string | number>("");
  const [tariff, setTariff] = useState<string | number>("");
  const [currency, setCurrency] = useState<string>("");
  const [occupancy, setOccupancy] = useState<string | number>("");
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
      qc.invalidateQueries({ queryKey: ["site", site.site_id] });
      // BI's own copy (the Setup checklist, Ratings) follows over the mirror.
      qc.invalidateQueries({ queryKey: ["bi-rating-sites"] });
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
    <div className="space-y-8 px-6 py-5">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
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
            hint="The FLAT rate — the simple case. If Time-of-Use slabs exist below, they override this entirely. No tariff is assumed if this is blank."
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
            read-only · recording needs <span className="font-mono">sites.update</span>
          </p>
        )}

        <Reason text="These are your assertions, not measurements. Nothing on this platform derives them and nothing fills them in; a blank field means NOT RECORDED, and Ratings refuses to score rather than default, estimate or borrow a figure." />
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
          <div
            className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2"
            title="Tracked separately from the site's own “updated” timestamp, which moves whenever anyone edits a phone number."
          >
            <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
              Last asserted
            </p>
            <p className="mt-1 text-[12px] text-nb-soft">
              {site.building_facts_updated_at
                ? new Date(site.building_facts_updated_at).toLocaleString()
                : "never"}
            </p>
          </div>
        </div>
      </div>
      </div>

      {/* The other two BI inputs live on the SAME tab, beside the facts they
          extend. The flat tariff above stays the simple case; when slabs exist
          they override it entirely (uncovered hours have no price). Both
          editors save the WHOLE list (PUT) so an empty list is a real
          retraction — and both ship empty. */}
      <div className="border-t border-nb-line pt-6">
        <TariffSlabsEditor site={site} />
      </div>
      <div className="border-t border-nb-line pt-6">
        <EmissionFactorsEditor site={site} />
      </div>
    </div>
  );
}
