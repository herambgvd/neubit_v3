"use client";

// CONFIG → RECORDING SCHEDULES. When each camera records, decided from here.
//
// This used to mean opening the recorder's own console — one at a time, for a
// decision an operator revisits weekly. The VMS could stream a recorder's footage,
// search it, export it and protect it, and could not say when to record it.
//
// LIBRARY ON THE LEFT, WEEK ON THE RIGHT. The week is the biggest thing on the
// screen because painting it is the work; naming and applying are what you do
// afterwards. Two other shapes were drawn and rejected: a camera-per-row matrix
// (better at auditing, worse at authoring) and a card deck of templates you drag
// cameras onto (fastest to assign, but it shrinks the week to a sparkline).
//
// THE TWO THINGS THIS SCREEN MUST NOT LET YOU BELIEVE:
//
//   * that editing a template changes the cameras it was applied to. It does not
//     — applying COPIES the document, and the copy is theirs. The recorder is
//     explicit about it, so the footer is too, and "Apply" stays a separate act
//     rather than an autosave.
//   * that a schedule means footage. A camera in `manual` mode has its week set
//     and ignores it. The apply dialog names those cameras, because a green
//     "applied" against a camera that will record nothing is the most expensive
//     kind of true.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog, type ConfirmState } from "@/components/ui/kit";
import {
  ConsoleGrid,
  ConsolePage,
  ConsolePanel,
  EmptyPane,
  IconButton,
  PanelHeader,
  PanelList,
  PanelSearch,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import type { FederationNode, ScheduleTemplate } from "./types";
import {
  coveredHours,
  docToWeek,
  emptyWeek,
  isAllOff,
  weekToDoc,
  type Slot,
  type Week,
} from "./components/weekSchedule";
import WeekPainter from "./components/WeekPainter";
import ScheduleTemplateModal from "./components/ScheduleTemplateModal";
import ApplyScheduleModal from "./components/ApplyScheduleModal";

const WRITE_PERM = "vms.config.manage";

const TOOLS: { slot: Slot; label: string; dot: string }[] = [
  { slot: "record", label: "Continuous", dot: "bg-nb-blue" },
  { slot: "motion", label: "Motion only", dot: "bg-amber-500" },
  { slot: "off", label: "Off", dot: "bg-[rgba(120,150,200,.18)]" },
];

/** A one-line summary of a template for the rail. Hours, not a shape: at rail width
 *  a sparkline of 168 cells is a smudge, and "45h / week" is the thing being
 *  compared between two named schedules. */
export function railSummary(t: ScheduleTemplate): string {
  const week = docToWeek(t.schedule);
  if (!week) return "written in another shape";
  const h = coveredHours(week);
  return h ? `${h}h scheduled per week` : "records nothing";
}


/** THE WEEK AND WHAT YOU CAN DO WITH IT — the painter, the tools, and the two
 *  things that are only true about a painted week.
 *
 *  Split out of the screen because the screen was doing four separate jobs
 *  (recorder choice, the template list, this, and the dialogs) and this one alone
 *  carries three conditions worth reading in isolation: whether the operator may
 *  write at all, whether the week does nothing, and whether there is an unsaved
 *  paint. Nested inside the page they were three more branches in a function
 *  nobody could hold in their head.
 */
function ScheduleWeek({
  week,
  dirty,
  mayWrite,
  tool,
  setTool,
  onPaint,
  onDiscard,
  onSave,
  saving,
  onApply,
}: Readonly<{
  week: Week;
  dirty: boolean;
  mayWrite: boolean;
  tool: Slot;
  setTool: (slot: Slot) => void;
  onPaint: (week: Week) => void;
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
  onApply: () => void;
}>) {
  const empty = isAllOff(week);
  return (
    <>
      <WeekPainter week={week} tool={tool} onChange={mayWrite ? onPaint : undefined} />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {mayWrite &&
          TOOLS.map((t) => (
            <button
              key={t.slot}
              type="button"
              onClick={() => setTool(t.slot)}
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] transition ${
                tool === t.slot
                  ? "border-nb-cyan/45 bg-nb-cyan/10 text-nb-cyan"
                  : "border-nb-line text-nb-muted hover:text-nb-text"
              }`}
            >
              <span className={`h-2.5 w-2.5 rounded-[3px] ${t.dot}`} />
              {t.label}
            </button>
          ))}
        <span className="text-[11.5px] text-nb-faint">
          {mayWrite
            ? "Drag to paint. Starting on an hour that already has the tool erases it."
            : "Read-only — changing a schedule needs config rights."}
        </span>
        <span className="ml-auto font-mono text-[11.5px] text-nb-soft">
          {coveredHours(week)}h / week
        </span>
      </div>

      {empty && (
        <p className="mt-3 rounded-[9px] border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-[11.5px] text-amber-200">
          Nothing is scheduled. A camera on this would record only when somebody presses record —
          and the recorder refuses to store a schedule this empty.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-nb-line pt-3">
        <span className="text-[11.5px] text-nb-faint">
          Applying copies this week onto a camera. Editing it afterwards does not reach back into
          cameras already set — re-apply to push a new version.
        </span>
        {mayWrite && (
          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <button
                type="button"
                onClick={onDiscard}
                className="rounded-md border border-nb-line px-2.5 py-1.5 text-[12px] text-nb-muted transition hover:text-nb-text"
              >
                Discard
              </button>
            )}
            <button
              type="button"
              disabled={!dirty || empty || saving}
              onClick={onSave}
              className="rounded-md border border-nb-cyan/45 bg-nb-cyan/10 px-2.5 py-1.5 text-[12px] text-nb-cyan transition hover:bg-nb-cyan/20 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save week"}
            </button>
            <button
              type="button"
              // Applying the STORED week, so an unsaved paint cannot be pushed onto
              // forty cameras and then lost on a refresh.
              disabled={dirty}
              title={dirty ? "Save the week before applying it" : undefined}
              onClick={onApply}
              className="rounded-md border border-nb-line px-2.5 py-1.5 text-[12px] text-nb-soft transition hover:text-nb-text disabled:opacity-40"
            >
              <Icon icon="heroicons-outline:arrow-right-circle" className="mr-1 inline text-xs" />
              Apply to cameras…
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export default function RecordingSchedules() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const mayWrite = can(WRITE_PERM);

  const [nodeId, setNodeId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tool, setTool] = useState<Slot>("record");
  // The unsaved paint, TAGGED with the template it belongs to. Clearing it from an
  // effect on selection change rendered one frame showing the previous template's
  // week under the new template's name; carrying the id means a draft simply stops
  // applying the moment the selection moves.
  const [draft, setDraft] = useState<{ id: string; week: Week } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduleTemplate | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const nodesQ = useQuery({ queryKey: ["federation-nodes"], queryFn: () => vms.federation.nodes() });
  const nodes = useMemo<FederationNode[]>(() => asItems(nodesQ.data), [nodesQ.data]);
  const node = nodes.find((n) => n.id === nodeId) ?? nodes[0] ?? null;

  const listQ = useQuery({
    queryKey: ["schedule-templates", node?.id],
    queryFn: () => vms.federation.schedules.list(node!.id),
    enabled: !!node?.id,
  });
  const templates = useMemo<ScheduleTemplate[]>(() => asItems(listQ.data), [listQ.data]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return templates;
    return templates.filter(
      (t) => t.name?.toLowerCase().includes(term) || t.description?.toLowerCase?.().includes(term),
    );
  }, [templates, search]);

  // The explicit choice, or the first row. Derived rather than synced by an effect,
  // which renders one frame with nothing selected before correcting itself.
  const effectiveId = selectedId ?? filtered[0]?.id ?? null;
  const selected = useMemo(
    () => templates.find((t) => t.id === effectiveId) ?? null,
    [templates, effectiveId],
  );

  // The stored week, or null when the recorder holds a document this console cannot
  // draw. Null is never flattened into an empty week: "records nothing" is a claim,
  // and making it about a parse failure is how a console says you are uncovered
  // when you are not.
  const stored = useMemo(() => docToWeek(selected?.schedule), [selected]);
  const mine = draft?.id === effectiveId ? draft.week : null;
  const week = mine ?? stored;
  const dirty = mine !== null;

  const save = useMutation({
    mutationFn: () =>
      vms.federation.schedules.update(node!.id, selected!.id, {
        name: selected!.name,
        description: selected!.description ?? "",
        schedule: weekToDoc(mine!),
      }),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["schedule-templates", node?.id] });
      toast.success("Schedule saved", {
        description: "Cameras already using it keep their copy — re-apply to push this version.",
      });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => vms.federation.schedules.remove(node!.id, id),
    onSuccess: () => {
      setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["schedule-templates", node?.id] });
      toast.success("Template removed", { description: "No camera lost its schedule." });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <ConsolePage>
      <ConsoleGrid>
        <ConsolePanel>
          <PanelHeader
            icon="heroicons:calendar-days"
            title="Schedules"
            count={templates.length || undefined}
            actions={
              mayWrite && node ? (
                <IconButton
                  icon="heroicons-outline:plus"
                  title="New schedule"
                  onClick={() => {
                    setEditTarget(null);
                    setFormOpen(true);
                  }}
                />
              ) : null
            }
          />
          {/* The recorder owns these; with one there is nothing to choose and the
              control would be furniture. */}
          {nodes.length > 1 && (
            <div className="px-3 pb-2">
              <select
                value={node?.id ?? ""}
                onChange={(e) => {
                  setNodeId(e.target.value);
                  setSelectedId(null);
                }}
                className="w-full rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2 text-[12.5px] text-nb-muted outline-hidden"
              >
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <PanelSearch value={search} onChange={setSearch} placeholder="Search schedules…" />
          <PanelList
            loading={listQ.isLoading || nodesQ.isLoading}
            error={listQ.error ? apiError(listQ.error) : undefined}
            empty={!filtered.length}
            emptyText={
              templates.length
                ? "No schedule matches that"
                : "No named schedules on this recorder yet"
            }
          >
            {filtered.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedId(t.id)}
                className={`w-full rounded-[10px] border px-3 py-2.5 text-left transition ${
                  t.id === effectiveId
                    ? "border-nb-cyan/45 bg-nb-cyan/10"
                    : "border-transparent hover:bg-nb-hover"
                }`}
              >
                <span className="block truncate text-[13px] font-semibold text-nb-text">{t.name}</span>
                <span className="block truncate text-[11.5px] text-nb-faint">
                  {t.description || railSummary(t)}
                </span>
              </button>
            ))}
          </PanelList>
        </ConsolePanel>

        <ConsolePanel className="min-w-0">
          {!selected ? (
            <EmptyPane
              icon="heroicons:calendar-days"
              title="No schedule selected"
              subtitle={
                node
                  ? "Name a week once here, then apply it to as many cameras as you like."
                  : "No recorder is federated yet, so there is nothing to schedule."
              }
            />
          ) : (
            <>
              <PanelHeader
                icon="heroicons:calendar-days"
                title={selected.name}
                actions={
                  mayWrite ? (
                    <>
                      <IconButton
                        icon="heroicons-outline:pencil-square"
                        title="Rename"
                        onClick={() => {
                          setEditTarget(selected);
                          setFormOpen(true);
                        }}
                      />
                      <IconButton
                        icon="heroicons-outline:trash"
                        title="Delete"
                        onClick={() =>
                          setConfirm({
                            title: `Delete “${selected.name}”?`,
                            message:
                              "The template goes; cameras it was applied to keep the schedule they were given.",
                            confirmLabel: "Delete",
                            danger: true,
                            onConfirm: () => remove.mutate(selected.id),
                          })
                        }
                      />
                    </>
                  ) : null
                }
              />

              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                {!week ? (
                  // The honest branch. This schedule is valid to the recorder and
                  // simply not a shape this painter knows; drawing an empty week
                  // would say it records nothing, which is a different and alarming
                  // claim.
                  <div className="rounded-[10px] border border-amber-500/35 bg-amber-500/8 px-4 py-6 text-[12.5px] text-amber-200">
                    <b className="block text-[13px]">This week cannot be drawn here</b>
                    The recorder accepts it, but it is written in a shape this painter does not
                    read. Open it on {node?.name ?? "the recorder"} to edit it, or replace it with a
                    new schedule painted here.
                  </div>
                ) : (
                  <ScheduleWeek
                    week={week}
                    dirty={dirty}
                    mayWrite={mayWrite}
                    tool={tool}
                    setTool={setTool}
                    onPaint={(next) => setDraft({ id: selected.id, week: next })}
                    onDiscard={() => setDraft(null)}
                    onSave={() => save.mutate()}
                    saving={save.isPending}
                    onApply={() => setApplyOpen(true)}
                  />
                )}
              </div>
            </>
          )}
        </ConsolePanel>
      </ConsoleGrid>

      {/* MOUNTED when open, not hidden: a dialog that is always present has to reset
          itself from an effect, and that renders once with the previous target's
          name in the field. */}
      {node && formOpen && (
        <ScheduleTemplateModal
          key={editTarget?.id ?? "new"}
          nodeId={node.id}
          template={editTarget}
          defaultWeek={editTarget ? null : emptyWeek()}
          onClose={() => setFormOpen(false)}
          onSaved={(saved) => {
            setFormOpen(false);
            setSelectedId(saved.id);
            qc.invalidateQueries({ queryKey: ["schedule-templates", node.id] });
          }}
        />
      )}
      {node && selected && applyOpen && (
        <ApplyScheduleModal
          key={selected.id}
          nodeId={node.id}
          template={selected}
          onClose={() => setApplyOpen(false)}
        />
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </ConsolePage>
  );
}
