"use client";

// Sites configuration — ported from neubit_v2's config/sites/page.jsx, rethemed to
// neubit_v3's Vercel tokens + kit components. Left list (search + status) and a right
// detail panel with three tabs: Site info · Floors · Zones. Site create/edit lives in a
// modal; the floor-plan editor opens full-screen from the Floors tab.
//
// Adaptations vs neubit_v2:
//   • CSS-var theme (--fg/--surface/…) → semantic tokens (foreground/muted/card/hover…).
//   • lib/api/sites axios module; image refs resolved via fileUrl().
//   • Dropped the geocoding "Get coordinates" button (no geocoding proxy in neubit_v3) —
//     latitude/longitude remain manual inputs.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, PageHeader, Spinner } from "@/components/ui/kit";
import { apiError, fileUrl } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { FloorPlanEditorModal } from "@/components/floor-builder/floor-plan-editor";
import TagPicker from "@/components/tags/TagPicker";

/* Backend canonical enums */
const SITE_TYPES = [
  "building", "campus", "facility", "warehouse", "headquarters",
  "branch", "retail", "office", "factory", "other",
];
const ZONE_TYPES = [
  "entrance", "parking", "office", "lobby", "server_room",
  "common_area", "corridor", "cafeteria", "security", "emergency_exit", "other",
];
const THREAT_LEVELS = ["normal", "elevated", "high", "critical", "lockdown"];

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Threat pills — fixed tailwind colors (opacity variants read fine on light + dark).
const THREAT_PILL = {
  normal: "bg-green-500/10 text-green-500 border-green-500/20",
  elevated: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  high: "bg-orange-500/10 text-orange-500 border-orange-500/20",
  critical: "bg-red-500/10 text-red-500 border-red-500/20",
  lockdown: "bg-hover text-foreground border-card-border",
};

export default function SitesConfigPage() {
  const qc = useQueryClient();
  const sitesQ = useQuery({
    queryKey: ["sites-list"],
    queryFn: () => sitesApi.list({ limit: 100 }),
  });

  const items = sitesQ.data?.items || [];
  const total = sitesQ.data?.total ?? items.length;
  const active = items.filter((s) => s.is_active !== false).length;
  const inactive = items.length - active;

  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [closed, setClosed] = useState(false);
  const [tab, setTab] = useState("info"); // info | floors | zones
  const [confirm, setConfirm] = useState(null);

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return items;
    return items.filter((s) => {
      const hay = [s.name, s.location_code, s.address?.city, s.address?.state, s.address?.country]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(f);
    });
  }, [items, q]);

  const selected = useMemo(
    () => items.find((s) => s.site_id === selectedId) || null,
    [items, selectedId],
  );

  useEffect(() => {
    if (mode === "view" && !closed && !selected && filtered[0]) {
      setSelectedId(filtered[0].site_id);
    }
  }, [filtered, selected, mode, closed]);

  useEffect(() => {
    setTab("info");
  }, [selectedId]);

  const remove = useMutation({
    mutationFn: (id) => sitesApi.remove(id),
    onSuccess: () => {
      toast.success("Site removed");
      qc.invalidateQueries({ queryKey: ["sites-list"] });
      setSelectedId(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const setThreatLevel = useMutation({
    mutationFn: ({ id, level }) => sitesApi.setThreatLevel(id, level),
    onSuccess: () => {
      toast.success("Threat level updated");
      qc.invalidateQueries({ queryKey: ["sites-list"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div>
      <PageHeader
        title="Sites"
        subtitle="Manage physical locations, floors and security zones."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/map"
              className="inline-flex items-center gap-2 rounded-md border border-card-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-hover"
            >
              <Icon icon="heroicons-outline:map" className="text-base" />
              Map view
            </Link>
            <Button variant="success" icon="heroicons-outline:plus" onClick={() => setMode("create")}>
              Add site
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[22rem_1fr] gap-4 min-h-[70vh]">
        {/* ── Left list ─────────────────────────────────────────── */}
        <aside className="rounded-xl border border-card-border bg-card flex flex-col min-h-0">
          <header className="flex items-center justify-between px-4 py-3 border-b border-card-border">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">Sites</span>
              <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-muted">
                {total}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                <span className="text-muted">{active}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-muted/50" />
                <span className="text-muted">{inactive}</span>
              </span>
            </div>
          </header>
          <div className="p-3">
            <label className="relative block">
              <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-base" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name or city…"
                className="h-9 w-full rounded-lg border border-field bg-transparent pl-8 pr-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted"
              />
            </label>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {sitesQ.isLoading ? (
              <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted">
                <Spinner className="!h-4 !w-4" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-hover">
                  <Icon icon="heroicons-outline:map-pin" className="text-lg text-muted" />
                </div>
                <div className="text-sm font-medium text-foreground">
                  {q.trim() ? "No sites match your search" : "No sites yet"}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {q.trim() ? "Try a different keyword." : "Click Add site to create your first site."}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-card-border">
                {filtered.map((s) => {
                  const isSelected = s.site_id === selectedId && mode !== "create";
                  const city = [s.address?.city, s.address?.state].filter(Boolean).join(", ");
                  return (
                    <li key={s.site_id} className="relative">
                      <button
                        onClick={() => {
                          setSelectedId(s.site_id);
                          setMode("view");
                          setClosed(false);
                        }}
                        className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${
                          isSelected ? "bg-hover" : "hover:bg-hover"
                        }`}
                      >
                        {isSelected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500" />}
                        <span className="relative inline-flex h-9 w-9 items-center justify-center rounded-md bg-hover text-muted shrink-0 overflow-hidden border border-card-border">
                          {s.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={fileUrl(s.image_url)} alt={s.name} className="h-full w-full object-cover" />
                          ) : (
                            <Icon icon="heroicons-outline:map-pin" className="text-base" />
                          )}
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card ${
                              s.is_active !== false ? "bg-green-500" : "bg-muted/50"
                            }`}
                          />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground truncate">{s.name}</span>
                            {s.site_type && (
                              <span className="text-[10px] rounded-full bg-blue-500/10 text-blue-500 px-1.5 py-0.5 font-medium capitalize">
                                {s.site_type}
                              </span>
                            )}
                          </span>
                          {city && <span className="block text-xs text-muted truncate">{city}</span>}
                          {s.location_code && (
                            <span className="block text-[10px] font-mono text-muted/70 truncate">{s.location_code}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* ── Right detail ──────────────────────────────────────── */}
        <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-0 flex flex-col">
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
                <Icon icon="heroicons-outline:map-pin" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-foreground">No site selected</div>
              <div className="text-xs text-muted mt-0.5">
                Pick one from the list, or click <b>Add site</b> to create a new site.
              </div>
            </div>
          ) : (
            <SiteDetail
              site={selected}
              tab={tab}
              onTabChange={setTab}
              onClose={() => {
                setSelectedId(null);
                setClosed(true);
              }}
              onEdit={() => setMode("edit")}
              onDelete={() =>
                setConfirm({
                  title: "Delete site?",
                  message: `Delete site "${selected.name}" and all of its floors and zones? This cannot be undone.`,
                  confirmLabel: "Delete",
                  onConfirm: () => {
                    remove.mutate(selected.site_id);
                    setConfirm(null);
                  },
                })
              }
              onChangeThreat={(level) => setThreatLevel.mutate({ id: selected.site_id, level })}
            />
          )}
        </section>
      </div>

      {(mode === "create" || mode === "edit") && (
        <SiteFormModal
          key={mode === "edit" ? selected?.site_id : "create"}
          site={mode === "edit" ? selected : null}
          allSites={items}
          onCancel={() => setMode("view")}
          onSaved={(saved) => {
            qc.invalidateQueries({ queryKey: ["sites-list"] });
            if (saved?.site_id) setSelectedId(saved.site_id);
            setMode("view");
          }}
        />
      )}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}

/* ─── SiteDetail with tabs ──────────────────────────────────────── */
function SiteDetail({ site, tab, onTabChange, onClose, onEdit, onDelete, onChangeThreat }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500 shrink-0">
            <Icon icon="heroicons-outline:building-office-2" className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-foreground truncate">{site.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted flex-wrap">
              {site.location_code && <span className="font-mono">{site.location_code}</span>}
              {site.site_type && (
                <span className="rounded-full bg-blue-500/10 text-blue-500 px-2 py-0.5 font-medium capitalize">
                  {capitalize(site.site_type)}
                </span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  site.is_active !== false ? "bg-green-500/10 text-green-500" : "bg-hover text-muted"
                }`}
              >
                {site.is_active !== false ? "Active" : "Inactive"}
              </span>
              <span className={`rounded-full border px-2 py-0.5 font-medium uppercase tracking-wide ${THREAT_PILL[site.threat_level] || THREAT_PILL.normal}`}>
                Threat: {capitalize(site.threat_level || "normal")}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={site.threat_level || "normal"}
            onChange={(e) => onChangeThreat(e.target.value)}
            className="h-8 rounded-md border border-field bg-transparent px-2 text-xs text-foreground outline-none focus:border-muted"
            title="Set threat level"
          >
            {THREAT_LEVELS.map((t) => (
              <option key={t} value={t} className="bg-card text-foreground">{capitalize(t)}</option>
            ))}
          </select>
          <button onClick={onClose} title="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
            <Icon icon="heroicons-outline:x-mark" className="text-base" />
          </button>
          <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover">
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20">
            <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
          </button>
        </div>
      </header>

      <nav className="flex items-stretch border-b border-card-border px-2">
        {[
          { key: "info", label: "Site info", icon: "heroicons-outline:building-office-2" },
          { key: "floors", label: "Floors", icon: "heroicons-outline:square-3-stack-3d" },
          { key: "zones", label: "Zones", icon: "heroicons-outline:square-2-stack" },
        ].map(({ key, label, icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              onClick={() => onTabChange(key)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px ${
                active ? "text-foreground border-foreground" : "text-muted border-transparent hover:text-foreground"
              }`}
            >
              <Icon icon={icon} className="text-base" />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "info" ? (
          <SiteInfoPanel site={site} />
        ) : tab === "floors" ? (
          <FloorsPanel site={site} />
        ) : (
          <ZonesPanel site={site} />
        )}
      </div>
    </div>
  );
}

function Field({ label, full, children }) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function SiteInfoPanel({ site }) {
  const a = site.address || {};
  const fullAddress = [a.street, a.city, a.state, a.zip_code, a.country].filter(Boolean).join(", ");
  return (
    <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-5 gap-6">
      <div className="lg:col-span-3 space-y-4">
        {site.description && (
          <Field label="Description" full>
            <p className="text-sm text-muted">{site.description}</p>
          </Field>
        )}
        <Field label="Tags" full>
          <TagPicker entityType="site" entityId={site.site_id} />
        </Field>
        <Field label="Address" full>
          <p className="text-sm text-foreground">{fullAddress || "—"}</p>
        </Field>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <Field label="Street"><p className="text-sm text-foreground">{a.street || "—"}</p></Field>
          <Field label="City"><p className="text-sm text-foreground">{a.city || "—"}</p></Field>
          <Field label="State / region"><p className="text-sm text-foreground">{a.state || "—"}</p></Field>
          <Field label="Zip code"><p className="text-sm text-foreground">{a.zip_code || "—"}</p></Field>
          <Field label="Country"><p className="text-sm text-foreground">{a.country || "—"}</p></Field>
          <Field label="Coordinates">
            <p className="text-sm text-foreground">
              {site.coordinates ? `${site.coordinates.latitude}, ${site.coordinates.longitude}` : "—"}
            </p>
          </Field>
          <Field label="Contact person"><p className="text-sm text-foreground">{site.contact_person || "—"}</p></Field>
          <Field label="Contact phone"><p className="text-sm text-foreground">{site.contact_phone || "—"}</p></Field>
          <Field label="Email"><p className="text-sm text-foreground">{site.email_address || "—"}</p></Field>
          <Field label="Created"><p className="text-sm text-foreground">{site.created_at ? new Date(site.created_at).toLocaleString() : "—"}</p></Field>
          <Field label="Updated"><p className="text-sm text-foreground">{site.updated_at ? new Date(site.updated_at).toLocaleString() : "—"}</p></Field>
          {typeof site.floor_count === "number" && (
            <Field label="Floor count"><p className="text-sm text-foreground">{site.floor_count}</p></Field>
          )}
        </div>
      </div>

      <div className="lg:col-span-2">
        <div className="sticky top-4 rounded-xl border border-card-border bg-hover/40 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">Site image</div>
          {site.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(site.image_url)} alt={site.name} className="h-64 w-full rounded-lg border border-card-border object-cover" />
          ) : (
            <div className="h-64 w-full rounded-lg border border-dashed border-card-border bg-card flex flex-col items-center justify-center text-center px-4">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-hover text-muted">
                <Icon icon="heroicons-outline:map-pin" className="text-lg" />
              </span>
              <p className="mt-2 text-sm font-medium text-foreground">No site image</p>
              <p className="text-xs text-muted">Upload an image to show a site preview here</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Floors panel ───────────────────────────────────────────────── */
function FloorsPanel({ site }) {
  const qc = useQueryClient();
  const floorsQ = useQuery({
    queryKey: ["floors-list", site.site_id],
    queryFn: () => sitesApi.floors.list({ site_id: site.site_id, limit: 100 }),
  });

  const items = floorsQ.data?.items || [];
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editorFloor, setEditorFloor] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => sitesApi.floors.remove(id),
    onSuccess: () => {
      toast.success("Floor removed");
      qc.invalidateQueries({ queryKey: ["floors-list", site.site_id] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Floors</h3>
          <p className="text-xs text-muted">
            {items.length} floor(s) in <span className="font-medium">{site.name}</span>.
          </p>
        </div>
        {!creating && !editing && (
          <Button variant="success" icon="heroicons-outline:plus" onClick={() => setCreating(true)} className="!px-3 !py-1.5 text-xs">
            Add floor
          </Button>
        )}
      </div>

      {(creating || editing) && (
        <FloorForm
          site={site}
          floor={editing}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["floors-list", site.site_id] });
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {!creating && !editing &&
        (floorsQ.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="!h-4 !w-4" /> Loading floors…
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-card-border px-6 py-10 text-center text-sm text-muted">
            No floors yet. Click <b>Add floor</b> to create one.
          </div>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border bg-card">
            {items.map((f) => (
              <li key={f.floor_id} className="flex items-start gap-3 px-4 py-3 hover:bg-hover">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 shrink-0 overflow-hidden border border-card-border">
                  {f.floorplan_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={fileUrl(f.floorplan_url)} alt={f.name} className="h-full w-full object-cover" />
                  ) : (
                    <Icon icon="heroicons-outline:square-3-stack-3d" className="text-base" />
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">{f.name}</span>
                    {typeof f.floor_number === "number" && (
                      <span className="text-[10px] rounded-full bg-hover text-muted px-1.5 py-0.5 font-medium">L{f.floor_number}</span>
                    )}
                    <span className="text-[10px] rounded-full bg-green-500/10 text-green-500 px-1.5 py-0.5 font-medium">
                      {f.zone_count ?? 0} zone(s)
                    </span>
                    {f.is_active === false && (
                      <span className="text-[10px] rounded-full bg-hover text-muted px-1.5 py-0.5 font-medium">Inactive</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {f.total_area ? `${f.total_area} m² · ` : ""}
                    {f.description || "No description"}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => setEditorFloor(f)} title="Open floor plan editor" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-blue-500">
                    <Icon icon="heroicons-outline:map" className="text-sm" />
                  </button>
                  <button onClick={() => setEditing(f)} title="Edit" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
                    <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
                  </button>
                  <button
                    onClick={() =>
                      setConfirm({
                        title: "Delete floor?",
                        message: `Delete floor "${f.name}" and all its zones?`,
                        confirmLabel: "Delete",
                        onConfirm: () => {
                          remove.mutate(f.floor_id);
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
            ))}
          </ul>
        ))}

      <FloorPlanEditorModal
        open={!!editorFloor}
        floor={editorFloor}
        onClose={() => setEditorFloor(null)}
        onSaved={() => qc.invalidateQueries({ queryKey: ["floors-list", site.site_id] })}
      />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}

/* ─── Small themed form inputs ──────────────────────────────────── */
function FLabel({ children, required }) {
  return (
    <label className="text-xs font-medium uppercase tracking-wide text-muted">
      {children}
      {required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
}
const FIELD_CLS =
  "mt-1 h-10 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted";

function FInput({ label, required, full, value, onChange, placeholder, type = "text", step, min }) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <FLabel required={required}>{label}</FLabel>
      <input
        type={type}
        step={step}
        min={min}
        value={value === null || value === undefined ? "" : value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={FIELD_CLS}
      />
    </div>
  );
}
function FTextarea({ label, full, value, onChange, rows, placeholder }) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <FLabel>{label}</FLabel>
      <textarea
        rows={rows}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted"
      />
    </div>
  );
}
function FSelect({ label, full, required, value, onChange, children }) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <FLabel required={required}>{label}</FLabel>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)} className={FIELD_CLS}>
        {children}
      </select>
    </div>
  );
}
function FCheckbox({ label, value, onChange }) {
  return (
    <label className="flex items-center gap-2 h-10 px-3 rounded-lg border border-field bg-transparent text-sm cursor-pointer">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-foreground">{label}</span>
    </label>
  );
}
function ImagePreviewCard({ title, subtitle, imageUrl, emptyText }) {
  return (
    <div className="rounded-lg border border-card-border bg-card overflow-hidden">
      <div className="px-3 py-2 border-b border-card-border bg-hover/40">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
        <p className="text-[11px] text-muted/70 truncate">{subtitle}</p>
      </div>
      <div className="p-3">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt={`${title} preview`} className="h-28 w-full rounded-md border border-card-border object-cover" />
        ) : (
          <div className="h-28 w-full rounded-md border border-dashed border-card-border bg-hover/30 px-3 flex items-center justify-center text-center text-[11px] text-muted/70">
            {emptyText}
          </div>
        )}
      </div>
    </div>
  );
}

function FloorForm({ site, floor, onCancel, onSaved }) {
  const isEdit = !!floor;
  const [name, setName] = useState(floor?.name || "");
  const [floorNumber, setFloorNumber] = useState(floor?.floor_number ?? "");
  const [description, setDescription] = useState(floor?.description || "");
  const [floorplanFile, setFloorplanFile] = useState(null);
  const [existingFloorplanUrl] = useState(floor?.floorplan_url || "");
  const [selectedPreview, setSelectedPreview] = useState("");
  const [totalArea, setTotalArea] = useState(floor?.total_area ?? "");
  const [isActive, setIsActive] = useState(floor?.is_active !== false);
  const [errors, setErrors] = useState({});
  const previewUrl = selectedPreview || (existingFloorplanUrl ? fileUrl(existingFloorplanUrl) : "");

  useEffect(() => {
    if (!floorplanFile) {
      setSelectedPreview("");
      return undefined;
    }
    const url = URL.createObjectURL(floorplanFile);
    setSelectedPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [floorplanFile]);

  const saving = useMutation({
    mutationFn: async ({ body, file }) => {
      if (isEdit) {
        const updated = await sitesApi.floors.update(floor.floor_id, body);
        if (file) return sitesApi.floors.replaceFloorplan(floor.floor_id, file);
        return updated;
      }
      return sitesApi.floors.createWithUpload({
        site_id: site.site_id,
        name: body.name,
        floor_number: body.floor_number,
        description: body.description,
        total_area: body.total_area,
        file,
      });
    },
    onSuccess: () => {
      setErrors({});
      toast.success(isEdit ? "Floor updated" : "Floor created");
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!isEdit && !floorplanFile) next.floorplan = "Floor plan image is required";
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const body = {
      name: name.trim(),
      floor_number: floorNumber === "" ? null : Number(floorNumber),
      description: description.trim() || null,
      total_area: totalArea === "" ? null : Number(totalArea),
    };
    if (isEdit) body.is_active = isActive;
    saving.mutate({ body, file: floorplanFile });
  }

  function onPick(e) {
    const file = e.target.files?.[0] || null;
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|svg\+xml)$/i.test(file.type)) {
      toast.error("Use PNG, JPEG, WEBP, or SVG image");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Floor plan image must be 8 MiB or smaller");
      return;
    }
    setErrors((p) => {
      const n = { ...p };
      delete n.floorplan;
      return n;
    });
    setFloorplanFile(file);
  }

  return (
    <form noValidate onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit floor · ${floor.name}` : "Add floor"}</h4>
        <button type="button" onClick={onCancel} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <FLabel required>Name</FLabel>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
            }}
            placeholder="Enter floor name"
            className={`${FIELD_CLS} ${errors.name ? "!border-red-500" : ""}`}
          />
          {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
        </div>
        <FInput label="Floor number" type="number" value={floorNumber} onChange={setFloorNumber} placeholder="0 for ground" />
        <FInput label="Total area (m²)" type="number" step="any" value={totalArea} onChange={setTotalArea} placeholder="Total area in m²" />
        <div>
          <FLabel required={!isEdit}>Floor plan image</FLabel>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={onPick}
            className="mt-1 block w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground"
          />
          <p className="mt-1 text-[11px] text-muted">Allowed: PNG, JPEG, WEBP, SVG (max 8 MiB)</p>
          {errors.floorplan && <p className="mt-1 text-xs text-red-500">{errors.floorplan}</p>}
          <div className="mt-3">
            <ImagePreviewCard
              title="Preview"
              subtitle={
                floorplanFile
                  ? `${floorplanFile.name} · ${(floorplanFile.size / (1024 * 1024)).toFixed(2)} MiB`
                  : existingFloorplanUrl
                    ? "Currently uploaded floor plan"
                    : "No floor plan uploaded yet"
              }
              imageUrl={previewUrl}
              emptyText="Current uploaded image will appear here"
            />
          </div>
        </div>
        <FTextarea label="Description" full value={description} onChange={setDescription} rows={2} placeholder="Floor description (optional)" />
        {isEdit && <FCheckbox label="Active" value={isActive} onChange={setIsActive} />}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending || (!isEdit && !floorplanFile)} className="!px-3 !py-1.5 text-xs">
          {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create floor"}
        </Button>
      </div>
    </form>
  );
}

/* ─── Zones panel ────────────────────────────────────────────────── */
function ZonesPanel({ site }) {
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

function ZoneForm({ site, floors, zone, defaultFloorId, onCancel, onSaved }) {
  const isEdit = !!zone;
  const [floorId, setFloorId] = useState(zone?.floor_id || defaultFloorId || "");
  const [name, setName] = useState(zone?.name || "");
  const [description, setDescription] = useState(zone?.description || "");
  const [zoneType, setZoneType] = useState(zone?.zone_type || "other");
  const [threatLevel, setThreatLevel] = useState(zone?.threat_level || "normal");
  const [color, setColor] = useState(zone?.color || "#6366F1");
  const [maxOccupancy, setMaxOccupancy] = useState(zone?.max_occupancy ?? "");
  const [alertOnEntry, setAlertOnEntry] = useState(!!zone?.alert_on_entry);
  const [alertOnExit, setAlertOnExit] = useState(!!zone?.alert_on_exit);
  const [isActive, setIsActive] = useState(zone?.is_active !== false);
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => (isEdit ? sitesApi.zones.update(zone.zone_id, body) : sitesApi.zones.create(body)),
    onSuccess: () => {
      setErrors({});
      toast.success(isEdit ? "Zone updated" : "Zone created");
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!isEdit && !floorId) next.floorId = "Floor is required";
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      zone_type: zoneType,
      threat_level: threatLevel,
      color: color || null,
      alert_on_entry: alertOnEntry,
      alert_on_exit: alertOnExit,
      max_occupancy: maxOccupancy === "" ? null : Number(maxOccupancy),
    };
    if (isEdit) body.is_active = isActive;
    else {
      body.site_id = site.site_id;
      body.floor_id = floorId;
    }
    saving.mutate(body);
  }

  return (
    <form noValidate onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit zone · ${zone.name}` : "Add zone"}</h4>
        <button type="button" onClick={onCancel} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {!isEdit && (
          <div>
            <FLabel required>Floor</FLabel>
            <select
              value={floorId || ""}
              onChange={(e) => {
                setFloorId(e.target.value);
                if (errors.floorId) setErrors((p) => ({ ...p, floorId: undefined }));
              }}
              className={`${FIELD_CLS} ${errors.floorId ? "!border-red-500" : ""}`}
            >
              <option value="" disabled className="bg-card">Select a floor</option>
              {floors.map((f) => (
                <option key={f.floor_id} value={f.floor_id} className="bg-card">{f.name}</option>
              ))}
            </select>
            {errors.floorId && <p className="mt-1 text-xs text-red-500">{errors.floorId}</p>}
          </div>
        )}
        <div>
          <FLabel required>Name</FLabel>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
            }}
            placeholder="Enter zone name"
            className={`${FIELD_CLS} ${errors.name ? "!border-red-500" : ""}`}
          />
          {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
        </div>
        <FSelect label="Zone type" value={zoneType} onChange={setZoneType}>
          {ZONE_TYPES.map((t) => (
            <option key={t} value={t} className="bg-card">{t.replace(/_/g, " ")}</option>
          ))}
        </FSelect>
        <FSelect label="Threat level" value={threatLevel} onChange={setThreatLevel}>
          {THREAT_LEVELS.map((t) => (
            <option key={t} value={t} className="bg-card">{capitalize(t)}</option>
          ))}
        </FSelect>
        <div>
          <FLabel>Color</FLabel>
          <div className="mt-1 flex items-center gap-2">
            <input type="color" value={color || "#6366F1"} onChange={(e) => setColor(e.target.value)} className="h-10 w-16 rounded-md border border-field cursor-pointer bg-transparent" />
            <input value={color || ""} onChange={(e) => setColor(e.target.value)} className="h-10 flex-1 rounded-md border border-field bg-transparent px-3 text-sm font-mono text-foreground outline-none focus:border-muted" />
          </div>
        </div>
        <FInput label="Max occupancy" type="number" min={0} value={maxOccupancy} onChange={setMaxOccupancy} placeholder="Max occupancy" />
        <FCheckbox label="Alert on entry" value={alertOnEntry} onChange={setAlertOnEntry} />
        <FCheckbox label="Alert on exit" value={alertOnExit} onChange={setAlertOnExit} />
        <FTextarea label="Description" full value={description} onChange={setDescription} rows={2} placeholder="Zone description (optional)" />
        {isEdit && <FCheckbox label="Active" value={isActive} onChange={setIsActive} />}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending || (!isEdit && !floorId)} className="!px-3 !py-1.5 text-xs">
          {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create zone"}
        </Button>
      </div>
    </form>
  );
}

/* ─── Site create / edit modal ──────────────────────────────────── */
const SITE_TYPE_PREFIX = {
  building: "BLD", campus: "CMP", facility: "FAC", warehouse: "WHS",
  headquarters: "HQ", branch: "BRN", retail: "RTL", office: "OFC",
  factory: "FCT", other: "STE",
};

function generateLocationCode(siteType) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `${SITE_TYPE_PREFIX[siteType] || "STE"}-${rand}`;
}

function Section({ title, children }) {
  return (
    <section>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">{title}</h4>
      {children}
    </section>
  );
}

function SiteFormModal({ site, allSites, onCancel, onSaved }) {
  const isEdit = !!site;
  const [name, setName] = useState(site?.name || "");
  const [locationCode, setLocationCode] = useState(
    site?.location_code || (isEdit ? "" : generateLocationCode(site?.site_type || "building")),
  );
  const [description, setDescription] = useState(site?.description || "");
  const [siteType, setSiteType] = useState(site?.site_type || "building");
  const [parentId, setParentId] = useState(site?.parent_id || "");
  const [threatLevel, setThreatLevel] = useState(site?.threat_level || "normal");
  const [street, setStreet] = useState(site?.address?.street || "");
  const [city, setCity] = useState(site?.address?.city || "");
  const [state, setState] = useState(site?.address?.state || "");
  const [zipCode, setZipCode] = useState(site?.address?.zip_code || "");
  const [country, setCountry] = useState(site?.address?.country || "India");
  const [latitude, setLatitude] = useState(site?.coordinates?.latitude ?? "");
  const [longitude, setLongitude] = useState(site?.coordinates?.longitude ?? "");
  const [contactPerson, setContactPerson] = useState(site?.contact_person || "");
  const [contactPhone, setContactPhone] = useState(site?.contact_phone || "");
  const [emailAddress, setEmailAddress] = useState(site?.email_address || "");
  const [errors, setErrors] = useState({});
  const [imageFile, setImageFile] = useState(null);
  const [existingImageUrl] = useState(site?.image_url || "");
  const [selectedPreview, setSelectedPreview] = useState("");
  const previewUrl = selectedPreview || (existingImageUrl ? fileUrl(existingImageUrl) : "");

  useEffect(() => {
    if (!imageFile) {
      setSelectedPreview("");
      return undefined;
    }
    const url = URL.createObjectURL(imageFile);
    setSelectedPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onCancel?.();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const saving = useMutation({
    mutationFn: async ({ body, file }) => {
      const saved = isEdit ? await sitesApi.update(site.site_id, body) : await sitesApi.create(body);
      if (file) return sitesApi.uploadImage(saved.site_id, file);
      return saved;
    },
    onSuccess: (saved) => {
      setErrors({});
      toast.success(isEdit ? "Site updated" : "Site created");
      onSaved(saved);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function buildAddress() {
    const obj = {
      street: street.trim() || null,
      city: city.trim() || null,
      state: state.trim() || null,
      zip_code: zipCode.trim() || null,
      country: country.trim() || null,
    };
    return Object.values(obj).some(Boolean) ? obj : null;
  }
  function buildCoords() {
    if (latitude === "" || longitude === "") return null;
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { latitude: lat, longitude: lng };
  }

  function submit(e) {
    e.preventDefault();
    setErrors({});
    if (!name.trim()) {
      setErrors({ name: "Name is required" });
      return;
    }
    saving.mutate({
      body: {
        name: name.trim(),
        location_code: locationCode.trim() || null,
        description: description.trim() || null,
        site_type: siteType,
        parent_id: parentId || null,
        threat_level: threatLevel,
        address: buildAddress(),
        coordinates: buildCoords(),
        contact_person: contactPerson.trim() || null,
        contact_phone: contactPhone.trim() || null,
        email_address: emailAddress.trim() || null,
      },
      file: imageFile,
    });
  }

  function onPickImage(e) {
    const file = e.target.files?.[0] || null;
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|svg\+xml)$/i.test(file.type)) {
      toast.error("Use PNG, JPEG, WEBP, or SVG image");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Site image must be 8 MiB or smaller");
      return;
    }
    setImageFile(file);
  }

  const parentChoices = (allSites || []).filter((s) => s.site_id !== site?.site_id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onCancel} />
      <div className="relative w-full max-w-3xl rounded-xl bg-card border border-card-border shadow-2xl animate-modal-in flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-card-border px-5 py-4 shrink-0">
          <div>
            <h3 className="text-base font-semibold text-foreground">{isEdit ? `Edit ${site?.name || "site"}` : "Create site"}</h3>
            <p className="text-xs text-muted mt-0.5">
              {isEdit ? "Update location details and contact info." : "Add a new physical location."}
            </p>
          </div>
          <button onClick={onCancel} className="text-muted hover:text-foreground transition">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>

        <form noValidate onSubmit={submit} className="flex flex-col min-h-0 flex-1">
          <div className="flex-1 px-6 py-6 space-y-6 overflow-y-auto">
            <Section title="Identity">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <FLabel required>Name</FLabel>
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (errors.name) setErrors({});
                    }}
                    placeholder="Enter site name"
                    className={`${FIELD_CLS} ${errors.name ? "!border-red-500" : ""}`}
                  />
                  {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
                </div>
                <div>
                  <FLabel>Location code</FLabel>
                  <div className="mt-1 flex gap-2">
                    <input value={locationCode} onChange={(e) => setLocationCode(e.target.value)} placeholder="Enter location code" className="h-10 flex-1 rounded-lg border border-field bg-transparent px-3 text-sm font-mono text-foreground outline-none focus:border-muted" />
                    {!isEdit && (
                      <button type="button" onClick={() => setLocationCode(generateLocationCode(siteType))} className="inline-flex items-center justify-center rounded-lg border border-card-border px-3 text-xs font-medium text-muted hover:bg-hover">
                        Regenerate
                      </button>
                    )}
                  </div>
                  {!isEdit && <p className="mt-1 text-[11px] text-muted/70">Auto-generated from site type. Edit or regenerate as you like.</p>}
                </div>
                <FSelect label="Site type" value={siteType} onChange={setSiteType}>
                  {SITE_TYPES.map((t) => (<option key={t} value={t} className="bg-card">{capitalize(t)}</option>))}
                </FSelect>
                <FSelect label="Threat level" value={threatLevel} onChange={setThreatLevel}>
                  {THREAT_LEVELS.map((t) => (<option key={t} value={t} className="bg-card">{capitalize(t)}</option>))}
                </FSelect>
                <FSelect label="Parent site" value={parentId} onChange={setParentId} full>
                  <option value="" className="bg-card">No parent</option>
                  {parentChoices.map((s) => (
                    <option key={s.site_id} value={s.site_id} className="bg-card">
                      {s.name}{s.location_code ? ` · ${s.location_code}` : ""}
                    </option>
                  ))}
                </FSelect>
                <FTextarea label="Description" full value={description} onChange={setDescription} rows={2} placeholder="Site description (optional)" />
              </div>
            </Section>
            <Section title="Address">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FInput label="Street" full value={street} onChange={setStreet} placeholder="Street address" />
                <FInput label="City" value={city} onChange={setCity} placeholder="City" />
                <FInput label="State / region" value={state} onChange={setState} placeholder="State or region" />
                <FInput label="Zip code" value={zipCode} onChange={setZipCode} placeholder="Zip code" />
                <FInput label="Country" value={country} onChange={setCountry} placeholder="Country" />
              </div>
            </Section>
            <Section title="Coordinates (optional)">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FInput label="Latitude" type="number" step="any" value={latitude} onChange={setLatitude} placeholder="Latitude" />
                <FInput label="Longitude" type="number" step="any" value={longitude} onChange={setLongitude} placeholder="Longitude" />
              </div>
              <p className="mt-2 text-[11px] text-muted/70">
                Sites with coordinates appear as pins on the <b>Map view</b>.
              </p>
            </Section>
            <Section title="Contact">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FInput label="Contact person" value={contactPerson} onChange={setContactPerson} placeholder="Contact person name" />
                <FInput label="Contact phone" value={contactPhone} onChange={setContactPhone} placeholder="Contact phone number" />
                <FInput label="Email" type="email" value={emailAddress} onChange={setEmailAddress} placeholder="Contact email address" />
                <div>
                  <FLabel>Site image</FLabel>
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={onPickImage} className="mt-1 block w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground" />
                  <p className="mt-1 text-[11px] text-muted">Allowed: PNG, JPEG, WEBP, SVG (max 8 MiB)</p>
                  <div className="mt-3">
                    <ImagePreviewCard
                      title="Preview"
                      subtitle={
                        imageFile
                          ? `${imageFile.name} · ${(imageFile.size / (1024 * 1024)).toFixed(2)} MiB`
                          : existingImageUrl
                            ? "Currently uploaded site image"
                            : "No site image uploaded yet"
                      }
                      imageUrl={previewUrl}
                      emptyText="Current uploaded image will appear here"
                    />
                  </div>
                </div>
              </div>
            </Section>
          </div>
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-card-border shrink-0">
            <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="success" disabled={saving.isPending}>
              {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create site"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
