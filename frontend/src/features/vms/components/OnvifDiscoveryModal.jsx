"use client";

// ONVIF discovery dialog — the multi-brand bulk-onboard flow. Three steps:
//   1. SCAN   — POST /vms/cameras/onvif/discover (optional CIDR + brand) → device
//               list. Each row can be probed (enrich: manufacturer/model/ptz/…) or
//               its credentials entered.
//   2. CHANNELS — pick a discovered device (or type a host manually), supply creds,
//               POST /vms/cameras/onvif/channels → the device's channels.
//   3. SELECT — tick the channels to onboard, name them, choose a target site, then
//               POST /vms/cameras/onvif/bulk-add → N cameras in one transaction.
// Ported from gvd_nvr's ONVIF discovery dialog UX, rethemed to v3 tokens.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button, Modal, Toggle } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { vms } from "../api";
import { CAMERA_BRANDS } from "../constants";

const STEPS = [
  { key: "scan", label: "Scan", icon: "heroicons-outline:magnifying-glass" },
  { key: "connect", label: "Connect", icon: "heroicons-outline:key" },
  { key: "select", label: "Channels", icon: "heroicons-outline:queue-list" },
];

function Stepper({ step }) {
  const idx = STEPS.findIndex((s) => s.key === step);
  return (
    <div className="mb-4 flex items-center gap-1">
      {STEPS.map((s, i) => (
        <div key={s.key} className="flex flex-1 items-center gap-1">
          <div
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
              i === idx
                ? "bg-foreground text-background"
                : i < idx
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "bg-hover text-muted"
            }`}
          >
            <Icon icon={i < idx ? "heroicons-outline:check" : s.icon} className="text-xs" />
            {s.label}
          </div>
          {i < STEPS.length - 1 && <div className="h-px flex-1 bg-card-border" />}
        </div>
      ))}
    </div>
  );
}

export default function OnvifDiscoveryModal({ onClose, onSuccess, sites = [] }) {
  const [step, setStep] = useState("scan");

  // Step 1 — scan
  const [network, setNetwork] = useState("");
  const [scanBrand, setScanBrand] = useState("");
  const [devices, setDevices] = useState([]);
  const [probes, setProbes] = useState({}); // ip → probe result

  // Step 2 — connect (creds for the chosen host)
  const [conn, setConn] = useState({ host: "", port: 80, username: "admin", password: "", brand: "onvif" });
  const [channels, setChannels] = useState([]);

  // Step 3 — selection
  const [selected, setSelected] = useState({}); // channel_number → { checked, name }
  const [targetSite, setTargetSite] = useState("");

  const scan = useMutation({
    mutationFn: () => vms.discovery.discover({ network: network || undefined, brand: scanBrand || undefined }),
    onSuccess: (res) => {
      const items = asItems(res);
      setDevices(items);
      if (items.length === 0) toast.message("No ONVIF devices found on the network.");
      else toast.success(`Found ${items.length} device(s)`);
    },
    onError: (e) => toast.error(apiError(e, "Scan failed")),
  });

  const probeOne = useMutation({
    mutationFn: ({ host, port }) =>
      vms.discovery.probe({ host, port: port || 80, username: conn.username || "admin", password: conn.password || "", brand: scanBrand || "onvif" }),
    onSuccess: (res, vars) => setProbes((p) => ({ ...p, [vars.host]: res })),
    onError: (e) => toast.error(apiError(e, "Probe failed")),
  });

  const enumerate = useMutation({
    mutationFn: () =>
      vms.discovery.channels({
        host: conn.host,
        port: Number(conn.port) || 80,
        username: conn.username,
        password: conn.password,
        brand: conn.brand,
      }),
    onSuccess: (res) => {
      const items = asItems(res);
      setChannels(items);
      const sel = {};
      for (const c of items) sel[c.channel] = { checked: true, name: c.name || `Channel ${c.channel}` };
      setSelected(sel);
      setStep("select");
      if (items.length === 0) toast.message("No channels enumerated — is this a single camera?");
    },
    onError: (e) => toast.error(apiError(e, "Channel enumeration failed")),
  });

  const bulkAdd = useMutation({
    mutationFn: () => {
      const chans = channels
        .filter((c) => selected[c.channel]?.checked)
        .map((c) => ({
          channel_number: c.channel_number ?? c.channel,
          name: selected[c.channel]?.name || c.name,
          profile_token: c.source_token || undefined,
          site_id: targetSite || undefined,
        }));
      return vms.discovery.bulkAdd({
        host: conn.host,
        port: Number(conn.port) || 80,
        username: conn.username,
        password: conn.password,
        brand: conn.brand,
        channels: chans,
      });
    },
    onSuccess: (res) => {
      const n = Array.isArray(res) ? res.length : res?.total ?? asItems(res).length;
      toast.success(`Added ${n || "the"} camera(s)`);
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Bulk-add failed")),
  });

  // Move a discovered device into the connect step.
  const chooseDevice = (d) => {
    setConn({
      host: d.ip || d.xaddr || "",
      port: d.port || 80,
      username: conn.username || "admin",
      password: conn.password || "",
      brand: d.brand || scanBrand || "onvif",
    });
    setStep("connect");
  };

  const selectedCount = channels.filter((c) => selected[c.channel]?.checked).length;

  return (
    <Modal
      open
      onClose={onClose}
      title="ONVIF Discovery"
      wide
      footer={
        step === "scan" ? (
          <>
            <Button variant="ghost" onClick={() => setStep("connect")}>
              Enter host manually
            </Button>
            <div className="flex-1" />
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" icon="heroicons-outline:magnifying-glass" onClick={() => scan.mutate()} disabled={scan.isPending}>
              {scan.isPending ? "Scanning…" : "Scan network"}
            </Button>
          </>
        ) : step === "connect" ? (
          <>
            <Button variant="ghost" onClick={() => setStep("scan")}>
              Back
            </Button>
            <div className="flex-1" />
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              icon="heroicons-outline:queue-list"
              onClick={() => enumerate.mutate()}
              disabled={!conn.host || enumerate.isPending}
            >
              {enumerate.isPending ? "Enumerating…" : "Enumerate channels"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep("connect")}>
              Back
            </Button>
            <div className="flex-1" />
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="success"
              icon="heroicons-outline:plus"
              onClick={() => bulkAdd.mutate()}
              disabled={selectedCount === 0 || bulkAdd.isPending}
            >
              {bulkAdd.isPending ? "Adding…" : `Add ${selectedCount} camera${selectedCount === 1 ? "" : "s"}`}
            </Button>
          </>
        )
      }
    >
      <Stepper step={step} />

      {/* STEP 1 — SCAN */}
      {step === "scan" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Network (CIDR)"
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
              placeholder="Auto-detect — e.g. 192.168.1.0/24"
            />
            <Field
              as="select"
              label="Brand filter"
              value={scanBrand}
              onChange={(e) => setScanBrand(e.target.value)}
              options={[{ value: "", label: "Any brand" }, ...CAMERA_BRANDS.map((b) => ({ value: b.value, label: b.label }))]}
            />
          </div>

          {devices.length > 0 ? (
            <div className="max-h-72 space-y-1.5 overflow-y-auto rounded-lg border border-card-border p-2">
              {devices.map((d) => {
                const pr = probes[d.ip];
                return (
                  <div key={d.ip + d.port} className="rounded-lg border border-card-border bg-card px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {d.name || d.manufacturer || "ONVIF device"}
                        </p>
                        <p className="truncate font-mono text-[11px] text-muted">
                          {d.ip}:{d.port} {d.mac ? `· ${d.mac}` : ""}
                        </p>
                        {pr && (
                          <p className="mt-0.5 text-[11px] text-emerald-500">
                            {pr.reachable
                              ? `${pr.manufacturer || ""} ${pr.model || ""} · ${pr.channel_count} ch${pr.has_ptz ? " · PTZ" : ""}`
                              : pr.error || "Unreachable"}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          title="Probe (needs creds below-right)"
                          onClick={() => probeOne.mutate({ host: d.ip, port: d.port })}
                          disabled={probeOne.isPending}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
                        >
                          <Icon icon="heroicons-outline:signal" className="text-sm" />
                        </button>
                        <Button variant="secondary" className="!px-2.5 !py-1 !text-xs" onClick={() => chooseDevice(d)}>
                          Select
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-card-border px-4 py-10 text-center text-xs text-muted">
              {scan.isPending ? (
                <span className="inline-flex items-center gap-2">
                  <Icon icon="svg-spinners:180-ring" className="text-base" /> Probing the network…
                </span>
              ) : (
                "Scan the LAN for ONVIF devices, or enter a host manually."
              )}
            </div>
          )}

          <div className="rounded-lg border border-card-border bg-hover/40 p-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Credentials for probing</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Username" value={conn.username} onChange={(e) => setConn({ ...conn, username: e.target.value })} placeholder="admin" />
              <Field label="Password" type="password" value={conn.password} onChange={(e) => setConn({ ...conn, password: e.target.value })} placeholder="••••••••" />
            </div>
          </div>
        </div>
      )}

      {/* STEP 2 — CONNECT */}
      {step === "connect" && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Host / IP" value={conn.host} onChange={(e) => setConn({ ...conn, host: e.target.value })} placeholder="192.168.1.108" />
            <Field label="Port" type="number" value={conn.port} onChange={(e) => setConn({ ...conn, port: e.target.value })} placeholder="80" />
            <Field
              as="select"
              label="Brand"
              value={conn.brand}
              onChange={(e) => setConn({ ...conn, brand: e.target.value })}
              options={CAMERA_BRANDS.map((b) => ({ value: b.value, label: b.label }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username" value={conn.username} onChange={(e) => setConn({ ...conn, username: e.target.value })} placeholder="admin" />
            <Field label="Password" type="password" value={conn.password} onChange={(e) => setConn({ ...conn, password: e.target.value })} placeholder="••••••••" />
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-card-border bg-hover px-3 py-2.5 text-[11px] text-muted">
            <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0 text-sm" />
            <span>
              Enumerate a multi-channel encoder / DVR to onboard all its channels at once. A single
              camera returns one channel — that's fine.
            </span>
          </div>
        </div>
      )}

      {/* STEP 3 — SELECT CHANNELS */}
      {step === "select" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">
              {selectedCount} of {channels.length} channel(s) selected
            </p>
            <Field
              as="select"
              value={targetSite}
              onChange={(e) => setTargetSite(e.target.value)}
              options={[{ value: "", label: "— No site —" }, ...sites.map((s) => ({ value: s.site_id, label: s.name }))]}
              containerClassName="w-48"
            />
          </div>

          <div className="max-h-80 space-y-1.5 overflow-y-auto rounded-lg border border-card-border p-2">
            {channels.map((c) => {
              const s = selected[c.channel] || {};
              return (
                <div key={c.channel} className="flex items-center gap-3 rounded-lg border border-card-border bg-card px-3 py-2">
                  <Toggle
                    checked={!!s.checked}
                    onChange={(v) => setSelected((prev) => ({ ...prev, [c.channel]: { ...prev[c.channel], checked: v } }))}
                  />
                  <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-hover text-[11px] font-semibold text-muted">
                    {c.channel_number ?? c.channel}
                  </div>
                  <input
                    value={s.name || ""}
                    onChange={(e) => setSelected((prev) => ({ ...prev, [c.channel]: { ...prev[c.channel], name: e.target.value } }))}
                    placeholder={c.name || `Channel ${c.channel}`}
                    className="h-9 flex-1 rounded-lg border border-field bg-transparent px-3 text-sm text-foreground placeholder:text-muted outline-none focus:border-muted"
                  />
                  <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
                    {c.main?.resolution && <span>{c.main.resolution}</span>}
                    {c.ptz_capable && (
                      <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 text-blue-500">PTZ</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}
