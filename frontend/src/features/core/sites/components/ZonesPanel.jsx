"use client";

// "Zones" tab body — lists a site's security zones with a floor filter and
// add/edit/delete. Owns floors + zones queries, delete mutation, and the in-place
// ZoneForm. Zones show a color chip, type/threat pills, floor label, and tags.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import TagPicker from "@/components/tags/TagPicker";
import { THREAT_PILL } from "../constants";
import ZoneForm from "./ZoneForm";

export default function ZonesPanel({ site }) {
  const qc = useQueryClient();
  const floorsQ = useQuery({
    queryKey: ["floors-list", site.site_id],
    queryFn: () => sitesApi.floors.list({ site_id: site.site_id, limit: 100 }),
  });
  const floors = floorsQ.data?.items || [];

  const [floorFilter, setFloorFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const zonesQ = useQuery({
    queryKey: ["zones-list", site.site_id, floorFilter],
    queryFn: () =>
      sitesApi.zones.list({
        site_id: site.site_id,
        ...(floorFilter ? { floor_id: floorFilter } : {}),
        limit: 100,
      }),
  });

  const items = zonesQ.data?.items || [];

  const remove = useMutation({
    mutationFn: (id) => sitesApi.zones.remove(id),
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
          <h3 className="text-sm font-semibold text-foreground">Zones</h3>
          <p className="text-xs text-muted">
            {items.length} zone(s){floorFilter ? " on selected floor" : ` across ${floors.length} floor(s)`}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={floorFilter}
            onChange={(e) => setFloorFilter(e.target.value)}
            className="h-8 rounded-md border border-field bg-transparent px-2 text-xs text-foreground outline-none focus:border-muted"
          >
            <option value="" className="bg-card">All floors</option>
            {floors.map((f) => (
              <option key={f.floor_id} value={f.floor_id} className="bg-card">{f.name}</option>
            ))}
          </select>
          {!creating && !editing && (
            <Button
              variant="success"
              icon="heroicons-outline:plus"
              onClick={() => setCreating(true)}
              disabled={floors.length === 0}
              className="!px-3 !py-1.5 text-xs"
            >
              Add zone
            </Button>
          )}
        </div>
      </div>

      {(creating || editing) && (
        <ZoneForm
          site={site}
          floors={floors}
          zone={editing}
          defaultFloorId={floorFilter}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["zones-list", site.site_id] });
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {zonesQ.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="!h-4 !w-4" /> Loading zones…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border px-6 py-10 text-center text-sm text-muted">
          No zones yet. {floors.length === 0 ? "Create a floor first." : "No zones available for this filter."}
        </div>
      ) : (
        <ul className="rounded-lg border border-card-border divide-y divide-card-border bg-card">
          {items.map((z) => {
            const f = floors.find((x) => x.floor_id === z.floor_id);
            return (
              <li key={z.zone_id} className="flex items-start gap-3 px-4 py-3 hover:bg-hover">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md shrink-0 text-white" style={{ background: z.color || "#6366F1" }}>
                  <Icon icon="heroicons-outline:square-2-stack" className="text-base" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">{z.name}</span>
                    {z.zone_type && (
                      <span className="text-[10px] rounded-full bg-blue-500/10 text-blue-500 px-1.5 py-0.5 font-medium capitalize">
                        {z.zone_type.replace(/_/g, " ")}
                      </span>
                    )}
                    <span className={`text-[10px] rounded-full border px-1.5 py-0.5 font-medium uppercase tracking-wide ${THREAT_PILL[z.threat_level] || THREAT_PILL.normal}`}>
                      {z.threat_level || "normal"}
                    </span>
                    {f && <span className="text-[10px] rounded-full bg-hover text-muted px-1.5 py-0.5">{f.name}</span>}
                    {z.is_active === false && <span className="text-[10px] rounded-full bg-hover text-muted px-1.5 py-0.5">Inactive</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
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
                  <button onClick={() => setEditing(z)} title="Edit" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
                    <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
                  </button>
                  <button
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
                    title="Delete"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10 hover:text-red-600"
                  >
                    <Icon icon="heroicons-outline:trash" className="text-sm" />
                  </button>
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
