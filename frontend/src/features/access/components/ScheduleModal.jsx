"use client";

// Schedule editor with a windows builder. Ported from neubit_v2's schedule-modal.jsx:
// name (required) + timezone, description, a repeatable time-window builder (day
// toggles + start/end), and a holidays list (YYYY-MM-DD chips). Rethemed to v3 tokens.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { gates } from "../api";
import { SCHEDULE_DAYS, TIMEZONES } from "../constants";

const DEFAULT_WINDOW = () => ({ days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "18:00" });

export default function ScheduleModal({ instanceId, schedule, onClose, onSuccess }) {
  const isEdit = !!schedule;
  const qc = useQueryClient();

  const scheduleQ = useQuery({
    queryKey: ["ac-schedule", instanceId, schedule?.schedule_id],
    queryFn: () => gates.schedules.get(instanceId, schedule.schedule_id),
    enabled: isEdit && !!instanceId,
    staleTime: 30_000,
  });
  const editSchedule = scheduleQ.data || schedule;

  const [form, setForm] = useState({
    name: schedule?.name || "",
    description: schedule?.description || "",
    timezone: schedule?.timezone || "Asia/Kolkata",
  });
  const [windows, setWindows] = useState(
    () =>
      schedule?.windows?.map((w) => ({ days: w.days || [], start_time: w.start_time || "09:00", end_time: w.end_time || "18:00" })) || [
        DEFAULT_WINDOW(),
      ],
  );
  const [holidays, setHolidays] = useState(schedule?.holidays || []);
  const [newHoliday, setNewHoliday] = useState("");
  const [errors, setErrors] = useState({});

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!editSchedule) return;
    setForm({
      name: editSchedule.name || "",
      description: editSchedule.description || "",
      timezone: editSchedule.timezone || "Asia/Kolkata",
    });
    setWindows(
      editSchedule.windows?.map((w) => ({ days: w.days || [], start_time: w.start_time || "09:00", end_time: w.end_time || "18:00" })) || [
        DEFAULT_WINDOW(),
      ],
    );
    setHolidays(editSchedule.holidays || []);
  }, [editSchedule]);

  const m = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        timezone: form.timezone,
        windows,
        holidays,
      };
      return isEdit ? gates.schedules.update(instanceId, schedule.schedule_id, body) : gates.schedules.create(instanceId, body);
    },
    onSuccess: () => {
      toast.success(isEdit ? "Schedule updated" : "Schedule created");
      qc.invalidateQueries({ queryKey: ["ac-schedules", instanceId] });
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const validate = () => {
    const next = {};
    if (!form.name.trim()) next.name = "Required";
    windows.forEach((w, i) => {
      if (!w.days?.length) next[`w${i}`] = "Pick at least one day";
      else if (!w.start_time || !w.end_time) next[`w${i}`] = "Start + end required";
      else if (w.start_time >= w.end_time) next[`w${i}`] = "End must be after start";
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = (e) => {
    e.preventDefault();
    if (validate()) m.mutate();
  };

  const addWindow = () => setWindows((ws) => [...ws, DEFAULT_WINDOW()]);
  const updateWindow = (idx, patch) => setWindows((ws) => ws.map((w, i) => (i === idx ? { ...w, ...patch } : w)));
  const removeWindow = (idx) => setWindows((ws) => ws.filter((_, i) => i !== idx));

  const addHoliday = () => {
    const v = newHoliday.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    setHolidays((h) => Array.from(new Set([...h, v])).sort());
    setNewHoliday("");
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit · ${editSchedule?.name || schedule.name}` : "New Schedule"}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="ac-schedule-form" variant="success" disabled={m.isPending}>
            {m.isPending ? "Saving…" : isEdit ? "Save changes" : "Create schedule"}
          </Button>
        </>
      }
    >
      <form id="ac-schedule-form" noValidate onSubmit={submit} className="space-y-5">
        {isEdit && scheduleQ.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading latest schedule...
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Office hours" error={errors.name} />
          <Field
            as="select"
            label="Timezone"
            value={form.timezone}
            onChange={(e) => set({ timezone: e.target.value })}
            options={TIMEZONES.map((t) => ({ value: t, label: t }))}
          />
        </div>

        <Field label="Description" value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Optional" />

        {/* Windows */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <FieldLabel>Time windows</FieldLabel>
            <button type="button" onClick={addWindow} className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-500 hover:underline">
              <Icon icon="heroicons-outline:plus" className="text-xs" /> Add window
            </button>
          </div>
          <div className="space-y-3">
            {windows.map((w, i) => (
              <div key={i} className="rounded-lg border border-card-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] text-muted">Window {i + 1}</span>
                  {windows.length > 1 && (
                    <button type="button" onClick={() => removeWindow(i)} className="rounded p-1 text-muted hover:bg-red-500/10 hover:text-red-500">
                      <Icon icon="heroicons-outline:x-mark" className="text-xs" />
                    </button>
                  )}
                </div>
                <div className="mb-2 flex flex-wrap gap-1">
                  {SCHEDULE_DAYS.map((d) => {
                    const on = w.days.includes(d.value);
                    return (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => updateWindow(i, { days: on ? w.days.filter((x) => x !== d.value) : [...w.days, d.value].sort() })}
                        className={`rounded px-2 py-1 text-[10px] font-medium uppercase ${
                          on ? "bg-foreground text-background" : "bg-hover text-muted hover:text-foreground"
                        }`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Start" type="time" value={w.start_time} onChange={(e) => updateWindow(i, { start_time: e.target.value })} />
                  <Field label="End" type="time" value={w.end_time} onChange={(e) => updateWindow(i, { end_time: e.target.value })} />
                </div>
                {errors[`w${i}`] && <p className="mt-1 text-[11px] text-red-500">{errors[`w${i}`]}</p>}
              </div>
            ))}
          </div>
        </div>

        {/* Holidays */}
        <div>
          <FieldLabel>Holidays</FieldLabel>
          <div className="mb-2 mt-1 flex flex-wrap gap-1">
            {holidays.length === 0 && <span className="text-[11px] text-muted/70">None</span>}
            {holidays.map((h) => (
              <span key={h} className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-500">
                {h}
                <button type="button" onClick={() => setHolidays((hs) => hs.filter((x) => x !== h))} className="hover:text-red-500">
                  <Icon icon="heroicons-outline:x-mark" className="text-xs" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="date"
              value={newHoliday}
              onChange={(e) => setNewHoliday(e.target.value)}
              className="rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-muted"
            />
            <Button type="button" variant="success" icon="heroicons-outline:plus" className="!px-2 !py-1 !text-xs" disabled={!newHoliday} onClick={addHoliday}>
              Add
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
