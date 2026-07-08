"use client";

// Access groups + schedules for one instance. Ported from neubit_v2's
// access-groups-tab.jsx: two stacked sections, each with an add button and a table.
// Groups table → name / type / api key / door chips / schedule name / description /
// actions. Schedules table → name+desc / timezone / windows / holiday count / actions.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { gates } from "../api";
import { DAY_LABELS } from "../constants";
import AccessGroupModal from "./AccessGroupModal";
import ScheduleModal from "./ScheduleModal";

export default function AccessGroupsTab({ instanceId }) {
  const qc = useQueryClient();
  const [groupCreate, setGroupCreate] = useState(false);
  const [groupEdit, setGroupEdit] = useState(null);
  const [scheduleCreate, setScheduleCreate] = useState(false);
  const [scheduleEdit, setScheduleEdit] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const groupsQ = useQuery({
    queryKey: ["ac-access-groups", instanceId],
    queryFn: () => gates.accessGroups.list(instanceId),
    enabled: !!instanceId,
  });
  const groups = asItems(groupsQ.data);

  const schedulesQ = useQuery({
    queryKey: ["ac-schedules", instanceId],
    queryFn: () => gates.schedules.list(instanceId),
    enabled: !!instanceId,
  });
  const schedules = asItems(schedulesQ.data);
  const scheduleById = useMemo(() => new Map(schedules.map((s) => [s.schedule_id, s])), [schedules]);

  const doorsQ = useQuery({
    queryKey: ["ac-doors", instanceId],
    queryFn: () => gates.doors.list({ instance_id: instanceId, limit: 500 }),
    enabled: !!instanceId,
  });
  const doorsById = useMemo(() => new Map(asItems(doorsQ.data).map((d) => [d.door_id, d])), [doorsQ.data]);

  const removeGroup = useMutation({
    mutationFn: (id) => gates.accessGroups.remove(instanceId, id),
    onSuccess: () => {
      toast.success("Group deleted");
      qc.invalidateQueries({ queryKey: ["ac-access-groups", instanceId] });
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const removeSchedule = useMutation({
    mutationFn: (id) => gates.schedules.remove(instanceId, id),
    onSuccess: () => {
      toast.success("Schedule deleted");
      qc.invalidateQueries({ queryKey: ["ac-schedules", instanceId] });
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Groups */}
      <Section
        icon="heroicons-outline:key"
        title="Access Groups"
        count={groups.length}
        loading={groupsQ.isLoading}
        onAdd={() => setGroupCreate(true)}
        addLabel="New group"
      >
        {groups.length === 0 ? (
          <Empty label="No access groups defined." />
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-hover">
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>API Key</Th>
                <Th>Doors</Th>
                <Th>Schedule</Th>
                <Th>Description</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border">
              {groups.map((g) => (
                <tr key={g.group_id} className="hover:bg-hover/50">
                  <td className="px-3 py-2 font-medium text-foreground">{g.name}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-500">
                      {g.access_group_type || "Door"}
                    </span>
                  </td>
                  <td className="max-w-[20ch] truncate px-3 py-2 font-mono text-[11px] text-muted">{g.api_key || "—"}</td>
                  <td className="px-3 py-2">
                    <DoorChips ids={g.door_ids} doorsById={doorsById} />
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {g.schedule_id ? scheduleById.get(g.schedule_id)?.name || shortId(g.schedule_id) : "Always allowed"}
                  </td>
                  <td className="px-3 py-2 text-muted">{g.description || "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <RowActions
                      onEdit={() => setGroupEdit(g)}
                      onDelete={() =>
                        setConfirm({
                          title: "Delete access group",
                          message: `Delete ${g.name}? Cardholders assigned to this group will lose the associated permissions.`,
                          confirmLabel: "Delete",
                          onConfirm: () => {
                            removeGroup.mutate(g.group_id);
                            setConfirm(null);
                          },
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Schedules */}
      <Section
        icon="heroicons-outline:calendar-days"
        title="Schedules"
        count={schedules.length}
        loading={schedulesQ.isLoading}
        onAdd={() => setScheduleCreate(true)}
        addLabel="New schedule"
      >
        {schedules.length === 0 ? (
          <Empty label="No schedules — groups will fall back to always-allowed." />
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-hover">
              <tr>
                <Th>Name</Th>
                <Th>Timezone</Th>
                <Th>Windows</Th>
                <Th>Holidays</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border">
              {schedules.map((s) => (
                <tr key={s.schedule_id} className="hover:bg-hover/50">
                  <td className="px-3 py-2 font-medium text-foreground">
                    {s.name}
                    {s.description && <div className="text-[10px] text-muted">{s.description}</div>}
                  </td>
                  <td className="px-3 py-2 text-muted">{s.timezone}</td>
                  <td className="px-3 py-2">
                    <WindowsCell windows={s.windows || []} />
                  </td>
                  <td className="px-3 py-2 text-muted">{(s.holidays || []).length}</td>
                  <td className="px-3 py-2 text-right">
                    <RowActions
                      onEdit={() => setScheduleEdit(s)}
                      onDelete={() =>
                        setConfirm({
                          title: "Delete schedule",
                          message: `Delete ${s.name}? Groups referencing it will fall back to always-allowed.`,
                          confirmLabel: "Delete",
                          onConfirm: () => {
                            removeSchedule.mutate(s.schedule_id);
                            setConfirm(null);
                          },
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {groupCreate && <AccessGroupModal instanceId={instanceId} onClose={() => setGroupCreate(false)} onSuccess={() => setGroupCreate(false)} />}
      {groupEdit && <AccessGroupModal instanceId={instanceId} group={groupEdit} onClose={() => setGroupEdit(null)} onSuccess={() => setGroupEdit(null)} />}
      {scheduleCreate && <ScheduleModal instanceId={instanceId} onClose={() => setScheduleCreate(false)} onSuccess={() => setScheduleCreate(false)} />}
      {scheduleEdit && <ScheduleModal instanceId={instanceId} schedule={scheduleEdit} onClose={() => setScheduleEdit(null)} onSuccess={() => setScheduleEdit(null)} />}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={removeGroup.isPending || removeSchedule.isPending} />
    </div>
  );
}

function Section({ icon, title, count, loading, onAdd, addLabel, children }) {
  return (
    <div className="rounded-lg border border-card-border bg-card">
      <div className="flex items-center gap-2 border-b border-card-border px-3 py-2">
        <Icon icon={icon} className="text-sm text-blue-500" />
        <span className="text-xs font-semibold text-foreground">{title}</span>
        <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">{loading ? "…" : count}</span>
        <div className="ml-auto">
          <Button variant="success" icon="heroicons-outline:plus" className="!px-2 !py-1 !text-[11px]" onClick={onAdd}>
            {addLabel}
          </Button>
        </div>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 p-3 text-xs text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading…
        </div>
      ) : (
        <div>{children}</div>
      )}
    </div>
  );
}

function Th({ children, align = "left" }) {
  return (
    <th className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Empty({ label }) {
  return <div className="px-3 py-6 text-center text-xs text-muted/70">{label}</div>;
}

function RowActions({ onEdit, onDelete }) {
  return (
    <div className="inline-flex items-center gap-1">
      <button type="button" onClick={onEdit} title="Edit" className="rounded p-1 text-muted hover:bg-hover hover:text-foreground">
        <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
      </button>
      <button type="button" onClick={onDelete} title="Delete" className="rounded p-1 text-red-500 hover:bg-red-500/10">
        <Icon icon="heroicons-outline:trash" className="text-sm" />
      </button>
    </div>
  );
}

function DoorChips({ ids, doorsById }) {
  if (!ids?.length) return <span className="text-[10px] text-muted/70">—</span>;
  const visible = ids.slice(0, 3);
  const overflow = ids.length - visible.length;
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((id) => {
        const d = doorsById.get(id);
        return (
          <span key={id} title={id} className="inline-flex items-center rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-500">
            {d?.name || shortId(id)}
          </span>
        );
      })}
      {overflow > 0 && <span className="inline-flex items-center rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted">+{overflow}</span>}
    </div>
  );
}

function WindowsCell({ windows }) {
  if (!windows.length) return <span className="text-[10px] text-muted/70">—</span>;
  return (
    <div className="space-y-0.5">
      {windows.slice(0, 3).map((w, i) => (
        <div key={i} className="text-[10px] text-muted">
          <span className="font-mono">{(w.days || []).map((d) => DAY_LABELS[d] || d).join("/")}</span> · {w.start_time}–{w.end_time}
        </div>
      ))}
      {windows.length > 3 && <div className="text-[10px] text-muted/70">+{windows.length - 3} more</div>}
    </div>
  );
}

function shortId(id) {
  if (!id) return "—";
  return String(id).length > 8 ? `${String(id).slice(0, 8)}…` : id;
}
