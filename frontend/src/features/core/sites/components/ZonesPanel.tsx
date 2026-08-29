"use client";

// "Zones" tab body — lists a site's security zones with a floor filter and
// edit/delete. Owns floors + zones queries, delete mutation, and the in-place
// ZoneForm. Zones show a color chip, type/threat pills, floor label, and tags.
//
// NO CREATE HERE — a zone is its polygon, so it's drawn in the floor-plan editor
// (Floors tab → Open floor plan). This tab manages the metadata of zones that
// already exist. See ZoneForm's header for why the create path was removed.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { RowAction } from "@/components/console";
import { ConfirmDialog, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import TagPicker from "@/components/tags/TagPicker";
import { THREAT_PILL } from "../constants";
import ZoneForm from "./ZoneForm";
import SelectMenu from "@/components/common/SelectMenu";

export default function ZonesPanel({ site }: any) {
  const qc = useQueryClient();
  const floorsQ = useQuery<any>({
    queryKey: ["floors-list", site.site_id],
    queryFn: () => sitesApi.floors.list({ site_id: site.site_id, limit: 100 }),
  });
  const floors = floorsQ.data?.items || [];

  const [floorFilter, setFloorFilter] = useState("");
  const [editing, setEditing] = useState<any>(null);
  const [confirm, setConfirm] = useState<any>(null);
  const zonesQ = useQuery<any>({
    queryKey: ["zones-list", site.site_id, floorFilter],
    queryFn: () =>
      sitesApi.zones.list({
        site_id: site.site_id,
        ...(floorFilter ? { floor_id: floorFilter } : {}),
        limit: 100,
      }),
  });

  const items = zonesQ.data?.items || [];

  const remove = useMutation<any>({
    mutationFn: (id: any) => sitesApi.zones.remove(id),
    onSuccess: () => {
      toast.success("Zone removed");
      qc.invalidateQueries({ queryKey: ["zones-list", site.site_id] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-nb-ink">Zones</h3>
          <p className="text-xs text-nb-muted">
            {items.length} zone(s){floorFilter ? " on selected floor" : ` across ${floors.length} floor(s)`}
            . Draw new zones in the floor plan editor.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-40">
            <SelectMenu
              value={floorFilter}
              onChange={(e) => setFloorFilter(e.target.value)}
              placeholder="All floors"
              options={[{ value: "", label: "All floors" }, ...floors.map((f) => ({ value: f.floor_id, label: f.name }))]}
              className="!mt-0 !h-8 !text-xs"
            />
          </span>
        </div>
      </div>

      {editing && (
        <ZoneForm
          zone={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["zones-list", site.site_id] });
            setEditing(null);
          }}
        />
      )}

      {zonesQ.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-nb-muted">
          <Spinner className="!h-4 !w-4" /> Loading zones…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-nb-line px-6 py-10 text-center text-sm text-nb-muted">
          {floors.length === 0
            ? "No zones yet. Create a floor first."
            : floorFilter
              ? "No zones on this floor yet."
              : "No zones yet."}
          <div className="mt-1 text-xs">
            Zones are drawn on the plan — open a floor from the{" "}
            <strong className="text-nb-ink">Floors</strong> tab and use{" "}
            <strong className="text-nb-ink">Zones → Draw</strong>.
          </div>
        </div>
      ) : (
        <ul className="rounded-lg border border-nb-line divide-y divide-nb-line bg-[rgba(8,15,34,.5)]">
          {items.map((z) => {
            const f = floors.find((x) => x.floor_id === z.floor_id);
            return (
              <li key={z.zone_id} className="flex items-start gap-3 px-4 py-3 hover:bg-white/5">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md shrink-0 text-white" style={{ background: z.color || "#6366F1" }}>
                  <Icon icon="heroicons-outline:square-2-stack" className="text-base" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-nb-ink">{z.name}</span>
                    {z.zone_type && (
                      <span className="text-[10px] rounded-full bg-blue-500/10 text-blue-500 px-1.5 py-0.5 font-medium capitalize">
                        {z.zone_type.replace(/_/g, " ")}
                      </span>
                    )}
                    <span className={`text-[10px] rounded-full border px-1.5 py-0.5 font-medium uppercase tracking-wide ${THREAT_PILL[z.threat_level] || THREAT_PILL.normal}`}>
                      {z.threat_level || "normal"}
                    </span>
                    {f && <span className="text-[10px] rounded-full bg-white/5 text-nb-muted px-1.5 py-0.5">{f.name}</span>}
                    {z.is_active === false && <span className="text-[10px] rounded-full bg-white/5 text-nb-muted px-1.5 py-0.5">Inactive</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-nb-muted">
                    {z.max_occupancy ? `Max occupancy: ${z.max_occupancy} · ` : ""}
                    {z.alert_on_entry ? "Alert on entry · " : ""}
                    {z.alert_on_exit ? "Alert on exit · " : ""}
                    {z.description || "No description"}
                  </div>
                  <div className="mt-2">
                    <TagPicker entityType="zone" entityId={z.zone_id} size="xs" />
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <RowAction icon="heroicons-outline:pencil-square" title="Edit" onClick={() => setEditing(z)} />
                  <RowAction
                    icon="heroicons-outline:trash"
                    title="Delete"
                    tone="danger"
                    onClick={() =>
                      setConfirm({
                        title: "Delete zone?",
                        message: `Delete zone "${z.name}"?`,
                        confirmLabel: "Delete",
                        onConfirm: () => {
                          remove.mutate(z.zone_id);
                          setConfirm(null);
                        },
                      })
                    }
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
