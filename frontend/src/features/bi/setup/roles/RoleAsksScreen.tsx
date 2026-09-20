"use client";

// BI → Setup → what each reading means, DEVICE BY DEVICE.
//
// The old screen was 494 readings in a table with a role picker on each row.
// Only three roles are read by anything effective on this estate, so 458 of
// those rows were work nobody needed and noise everybody had to read past.
//
// This screen walks the devices that have something to answer. Each question is
// one reading, in the words of the machine room ("this looks like the water
// going in"), with the tag's own reason, the metrics that read it, and the value
// it is carrying right now — because a role asserted on a reading nobody looked
// at is the mistake the confirm guard exists for. Where the platform would
// rather a person looked twice (no recent reading, another reading on the device
// already answers this, several readings claiming it) the caution is on the
// question and that question is left out of "yes to everything".
//
// Retraction is here too: a stored answer can be taken back, because a wrong
// one computes silently where a refusal would have been visible.
import Link from "next/link";
import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { LoadingBlock } from "@/components/console";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import NotReportingChallenge, { notReportingDetail, type NotReportingDetail } from "../../components/NotReportingChallenge";
import { bi } from "../../api";
import { MODULE, PERM_MANAGE, PERM_READ } from "../../constants";
import { metrics } from "../../metricsApi";
import { STRANDED_HREF } from "../routes";
import {
  bulkOf,
  cautionOf,
  fmtValue,
  neededByText,
  roleLong,
  roleShort,
  type RoleAsk,
  type RoleAsks,
} from "./asks";

interface Press {
  role: string | null;
  point_ids: string[];
}

export default function RoleAsksScreen() {
  const qc = useQueryClient();
  const still = !!useReducedMotion();
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  const mayWrite = mayRead && can(PERM_MANAGE);

  const q = useQuery<RoleAsks>({
    queryKey: ["bi-role-asks"],
    queryFn: () => bi.roleAsks(),
    enabled: mayRead,
  });
  const orphansQ = useQuery<{ orphans?: unknown[] }>({
    queryKey: ["bi-role-orphans", ""],
    queryFn: () => bi.roleOrphans(),
    enabled: mayRead,
  });
  const stranded = orphansQ.data ? (orphansQ.data.orphans ?? []).length : null;

  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A press the server refused because the reading carries nothing. Asserting
  // anyway is a SECOND, deliberate act — the `4FKC2_IWT` mistake in one line.
  const [challenge, setChallenge] = useState<{ detail: NotReportingDetail; message: string; presses: Press[] } | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());

  const devices = useMemo(
    () => (q.data?.devices ?? []).filter((d) => !skipped.has(d.device_tag ?? "")),
    [q.data, skipped],
  );
  const device = devices.find((d) => (d.device_tag ?? "") === picked) ?? devices[0] ?? null;

  const confirm = useMutation({
    mutationFn: async ({ presses, anyway }: { presses: Press[]; anyway?: boolean }) => {
      for (const p of presses) {
        await metrics.confirmRoles({
          point_ids: p.point_ids,
          role: p.role,
          ...(anyway ? { acknowledge_not_reporting: true } : {}),
        });
      }
    },
    onSuccess: () => {
      setError(null);
      setChallenge(null);
      qc.invalidateQueries({ queryKey: ["bi-role-asks"] });
      qc.invalidateQueries({ queryKey: ["bi-role-orphans", ""] });
    },
    onError: (e, vars) => {
      const detail = notReportingDetail(e);
      if (detail) {
        setChallenge({ detail, message: apiError(e, "Not stored"), presses: vars.presses });
        return;
      }
      setError(apiError(e, "Could not store it"));
    },
  });
  const press = (presses: Press[]) => {
    setError(null);
    setChallenge(null);
    confirm.mutate({ presses });
  };
  const busy = confirm.isPending;

  if (!mayRead) {
    return (
      <p className="pt-6 text-[12.5px] text-nb-faint">
        Needs <span className="font-mono">bi.read</span> and the analytics module.
      </p>
    );
  }
  if (q.isLoading) return <LoadingBlock label="Reading every device…" />;
  if (q.error) {
    return <p className="pt-4 text-[12.5px] text-nb-crit">{apiError(q.error, "Could not read the devices")}</p>;
  }

  const totals = q.data?.totals;
  const done = !device;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* what this screen is for, in one line */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-white/[.06] pb-3">
        <h2 className="text-[14.5px] font-semibold text-nb-ink">What each reading means</h2>
        <p className="text-[12.5px] text-nb-muted">
          {totals?.asks ? (
            <>
              {totals.asks} reading{totals.asks === 1 ? "" : "s"} on {devices.length} device
              {devices.length === 1 ? "" : "s"} — everything else is left alone
            </>
          ) : (
            "nothing is waiting"
          )}
        </p>
        <div className="ml-auto flex items-center gap-3 text-[12px]">
          {totals?.answered ? (
            <span className="flex items-center gap-1.5 text-nb-faint">
              <span className="h-1.5 w-1.5 rounded-full bg-nb-ok" />
              {totals.answered} answered
            </span>
          ) : null}
          {stranded ? (
            <Link
              href={STRANDED_HREF}
              className="flex items-center gap-1.5 rounded-[7px] border border-nb-warn/35 px-2 py-0.5 text-nb-warn transition hover:border-nb-warn/70"
            >
              <span className="font-mono">{stranded}</span> answers point at a dead reading
            </Link>
          ) : null}
        </div>
      </div>

      {done ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <p className="text-[15px] text-nb-ink">
            {totals?.answered
              ? `Every reading anything computes with has a meaning — ${totals.answered} of them.`
              : "Nothing on this estate needs a meaning yet."}
          </p>
          <p className="max-w-[520px] text-[12.5px] text-nb-faint">
            {totals?.points
              ? `${totals.points - (totals.answered ?? 0)} other readings are stored and nothing computes with them, so nothing asks about them.`
              : ""}
          </p>
          {skipped.size > 0 && (
            <button
              type="button"
              onClick={() => setSkipped(new Set())}
              className="mt-2 text-[12.5px] text-nb-blueb hover:underline"
            >
              Bring back {skipped.size} skipped device{skipped.size === 1 ? "" : "s"}
            </button>
          )}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 pt-3 lg:grid-cols-[25%_1fr]">
          {/* the rail */}
          <div className="min-h-0 overflow-y-auto rounded-[12px] border border-nb-line">
            <p className="px-3.5 py-2.5 text-[10.5px] uppercase tracking-[1.2px] text-nb-faint">Devices to answer</p>
            {devices.map((d) => {
              const on = d === device;
              return (
                <button
                  key={d.device_tag ?? "—"}
                  type="button"
                  onClick={() => setPicked(d.device_tag ?? "")}
                  className={`flex w-full items-center gap-2.5 border-t border-white/[.05] px-3.5 py-2.5 text-left transition ${
                    on ? "border-l-2 border-l-nb-blue bg-nb-blue/[.14]" : "hover:bg-white/[.03]"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[12.5px] ${on ? "text-nb-ink" : "text-nb-soft"}`}>
                      {d.device_tag || "(no device)"}
                    </span>
                    <span className="block truncate text-[11px] text-nb-faint">
                      {d.asks.length
                        ? `${d.asks.length} reading${d.asks.length === 1 ? "" : "s"} to answer`
                        : "all answered"}
                    </span>
                  </span>
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${d.asks.length ? "bg-nb-warn" : "bg-nb-ok"}`} />
                </button>
              );
            })}
            <p className="border-t border-white/[.05] px-3.5 py-2.5 text-[11px] text-nb-faint">
              Devices whose readings nothing computes with are not listed.
            </p>
          </div>

          {/* the device */}
          <div className="min-h-0 overflow-y-auto rounded-[12px] border border-nb-line px-5 py-4">
            <AnimatePresence mode="wait">
              <motion.div
                key={device.device_tag ?? "—"}
                initial={still ? false : { opacity: 0, x: 14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={still ? { opacity: 0 } : { opacity: 0, x: -14 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <h3 className="text-[17px] font-semibold text-nb-ink">{device.device_tag || "(no device)"}</h3>
                <p className="mt-1 text-[12.5px] text-nb-muted">
                  {device.site_name ? `${device.site_name} · ` : ""}
                  {device.asks.length} of its readings matter to something computed
                  {device.answered.length ? `, ${device.answered.length} already answered` : ""}.
                </p>

                <div className="mt-4 space-y-2.5">
                  {device.asks.map((a) => (
                    <Question
                      key={a.point_id}
                      ask={a}
                      mayWrite={mayWrite}
                      busy={busy}
                      onYes={() => press([{ role: a.role, point_ids: [a.point_id] }])}
                    />
                  ))}
                </div>

                {device.answered.length > 0 && (
                  <div className="mt-5">
                    <p className="text-[10.5px] uppercase tracking-[1.2px] text-nb-faint">Answered</p>
                    <div className="mt-2 space-y-1.5">
                      {device.answered.map((a) => (
                        <div
                          key={a.point_id}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-nb-ok/25 bg-nb-ok/[.05] px-3.5 py-2"
                        >
                          <span className="font-mono text-[12.5px] text-nb-blueb">{a.point_tag}</span>
                          <span className="text-[12.5px] text-nb-soft">{roleShort(a)}</span>
                          <span className="font-mono text-[11.5px] text-nb-faint">{fmtValue(a)}</span>
                          {mayWrite && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => press([{ role: null, point_ids: [a.point_id] }])}
                              className="ml-auto text-[12px] text-nb-faint transition hover:text-nb-crit disabled:opacity-50"
                            >
                              Take it back
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {challenge && (
                  <div className="mt-4">
                    <NotReportingChallenge
                      detail={challenge.detail}
                      message={challenge.message}
                      busy={busy}
                      onAssertAnyway={() => confirm.mutate({ presses: challenge.presses, anyway: true })}
                      onCancel={() => setChallenge(null)}
                    />
                  </div>
                )}

                {error && <p className="mt-4 text-[12.5px] text-nb-crit">{error}</p>}

                {mayWrite && device.asks.length > 0 && (
                  <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/[.06] pt-4">
                    {bulkOf(device).length > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => press(bulkOf(device))}
                        className="h-9 rounded-[9px] bg-nb-blue px-4 text-[13px] font-medium text-white transition hover:bg-nb-blueb disabled:opacity-50"
                      >
                        {busy
                          ? "Storing…"
                          : `Yes to ${bulkOf(device).reduce((n, p) => n + p.point_ids.length, 0)} on this device`}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setSkipped((s) => new Set(s).add(device.device_tag ?? ""))}
                      className="h-9 px-3 text-[13px] text-nb-muted transition hover:text-nb-ink disabled:opacity-50"
                    >
                      Skip this device
                    </button>
                    <span className="ml-auto text-[11.5px] text-nb-faint">
                      Readings with a caution are never stored by the button above.
                    </span>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}

function Question({
  ask,
  mayWrite,
  busy,
  onYes,
}: Readonly<{ ask: RoleAsk; mayWrite: boolean; busy: boolean; onYes: () => void }>) {
  const [other, setOther] = useState(false);
  const caution = cautionOf(ask);
  const reads = neededByText(ask.needed_by);
  const long = roleLong(ask);

  return (
    <div
      className={`rounded-[11px] border px-4 py-3 ${
        caution ? "border-nb-warn/30 bg-nb-warn/[.04]" : "border-white/[.09]"
      }`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="font-mono text-[13.5px] text-nb-ink">{ask.point_tag}</span>
            <span className="font-mono text-[11.5px] text-nb-faint">{fmtValue(ask)}</span>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-nb-soft">
            This looks like <strong className="font-semibold text-nb-ink">{roleShort(ask)}</strong>
            {long ? ` — ${long}` : ""}.{ask.basis ? ` ${ask.basis[0].toUpperCase()}${ask.basis.slice(1)}.` : ""}
          </p>
          {reads && <p className="mt-1 text-[11.5px] text-nb-faint">Needed by: {reads}.</p>}
          {caution && <p className="mt-1.5 text-[12px] text-nb-warn">{caution}</p>}
        </div>
        {mayWrite && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onYes}
              className="h-8 rounded-[8px] bg-nb-blue px-3.5 text-[12.5px] font-medium text-white transition hover:bg-nb-blueb disabled:opacity-50"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => setOther((v) => !v)}
              className="h-8 rounded-[8px] border border-white/[.14] px-3 text-[12.5px] text-nb-soft transition hover:border-nb-blue/50 hover:text-nb-ink"
            >
              It is something else
            </button>
          </div>
        )}
      </div>
      {other && (
        <p className="mt-2.5 border-t border-white/[.06] pt-2.5 text-[12px] text-nb-faint">
          Then leave it. Nothing is stored, and the one thing that reads it stays off and says why — better than a
          meaning nobody could stand behind.
        </p>
      )}
    </div>
  );
}
