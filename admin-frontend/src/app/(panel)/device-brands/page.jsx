"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Cpu, Loader2, Search, ShieldCheck, X } from "lucide-react";

import { adminApi, apiError } from "@/lib/api";

function normalize(res) {
  const rows = res?.items ?? res;
  return Array.isArray(rows) ? rows : [];
}

function Chip({ children, tone = "slate" }) {
  const cls = {
    slate: "border-card-border bg-card text-foreground",
    cyan: "border-cyan-400/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300",
  }[tone];
  return (
    <span className={"rounded-full border px-2 py-0.5 text-[11px] font-medium " + cls}>{children}</span>
  );
}

export default function DeviceBrandsPage() {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(null); // brand_id for detail drawer

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["device-brands"],
    queryFn: () => adminApi.listDeviceBrands(),
  });

  const brands = normalize(data);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return brands;
    return brands.filter(
      (b) =>
        (b.name || "").toLowerCase().includes(needle) ||
        (b.sdk_type || "").toLowerCase().includes(needle) ||
        (b.protocols || []).some((p) => (p || "").toLowerCase().includes(needle))
    );
  }, [brands, q]);

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Device Brands</h1>
          <p className="mt-1 text-sm text-muted">
            Supported camera and device integrations available to tenants.
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search brand, SDK or protocol…"
            className="h-10 w-full rounded-lg border border-card-border bg-card pl-9 pr-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20"
          />
        </div>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-2xl border border-card-border bg-card" />
          ))}
        </div>
      )}

      {isError && (
        <div className="rounded-2xl border border-red-400/20 bg-red-500/5 px-5 py-10 text-center text-sm text-red-600 dark:text-red-300">
          {apiError(error, "Failed to load device brands")}
        </div>
      )}

      {!isLoading && !isError && filtered.length === 0 && (
        <div className="rounded-2xl border border-card-border bg-card px-5 py-16 text-center">
          <div className="mx-auto flex max-w-xs flex-col items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-card-border bg-card text-cyan-600 dark:text-cyan-300">
              <Cpu className="h-5 w-5" />
            </div>
            <p className="mt-4 text-sm font-medium text-foreground">
              {q ? "No matching brands" : "No device brands"}
            </p>
            <p className="mt-1 text-xs text-muted">
              {q ? "Try a different search." : "No integrations are registered yet."}
            </p>
          </div>
        </div>
      )}

      {!isLoading && !isError && filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((b) => (
            <button
              key={b.brand_id}
              onClick={() => setSelected(b.brand_id)}
              className="animate-fade-in flex flex-col rounded-2xl border border-card-border bg-card p-5 text-left transition hover:border-muted hover:bg-hover"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-card text-cyan-600 dark:text-cyan-300">
                    <Cpu className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="font-medium text-foreground">{b.name}</div>
                    <div className="font-mono text-[11px] text-muted">{b.sdk_type || "—"}</div>
                  </div>
                </div>
                {b.is_installed ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" />
                    Installed
                  </span>
                ) : (
                  <span className="rounded-full border border-card-border bg-card px-2 py-0.5 text-[11px] font-medium text-muted">
                    Available
                  </span>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                {b.onvif && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-600 dark:text-cyan-300">
                    <ShieldCheck className="h-3 w-3" />
                    ONVIF
                  </span>
                )}
                {(b.protocols || []).slice(0, 4).map((p) => (
                  <Chip key={p}>{p}</Chip>
                ))}
              </div>

              {(b.capabilities || []).length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {(b.capabilities || []).slice(0, 5).map((c) => (
                    <Chip key={c} tone="cyan">
                      {c}
                    </Chip>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 text-xs text-muted">
        {brands.length} brand{brands.length === 1 ? "" : "s"}
        {isFetching ? " · updating…" : ""}
      </div>

      {selected && <BrandDrawer brandId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function BrandDrawer({ brandId, onClose }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["device-brands", brandId],
    queryFn: () => adminApi.getDeviceBrand(brandId),
  });

  const b = data || {};

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-modal-in relative z-10 flex h-full w-full max-w-md flex-col border-l border-card-border bg-card shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between gap-4 border-b border-card-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-card text-cyan-600 dark:text-cyan-300">
              <Cpu className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground">{b.name || brandId}</div>
              <div className="font-mono text-[11px] text-muted">{b.sdk_type || "—"}</div>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted transition hover:bg-hover hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : isError ? (
            <div className="py-10 text-center text-sm text-red-600 dark:text-red-300">
              {apiError(error, "Failed to load brand")}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-2">
                {b.onvif && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-medium text-cyan-600 dark:text-cyan-300">
                    <ShieldCheck className="h-3 w-3" />
                    ONVIF
                  </span>
                )}
                {b.is_installed ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" />
                    Installed
                  </span>
                ) : (
                  <span className="rounded-full border border-card-border bg-card px-2.5 py-0.5 text-xs font-medium text-muted">
                    Available
                  </span>
                )}
              </div>

              <Section title="Protocols">
                {(b.protocols || []).length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {b.protocols.map((p) => (
                      <Chip key={p}>{p}</Chip>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted">None listed.</p>
                )}
              </Section>

              <Section title="Capabilities">
                {(b.capabilities || []).length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {b.capabilities.map((c) => (
                      <Chip key={c} tone="cyan">
                        {c}
                      </Chip>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted">None listed.</p>
                )}
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </div>
  );
}
