"use client";

// ReportScheduleModal (P6-B) — create/edit a recurring report schedule.
//
// A schedule runs a report `kind` on a `cadence` (daily/weekly/monthly) at
// `hour_utc`, renders it in `export_format` (csv/pdf), and delivers to `recipients`
// over a `channel` (email). The report scheduler (vision) picks it up and notifies.
// Writes gate on vms.config.manage (enforced server-side).
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button, Input, Modal, Select, Toggle } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { vms } from "../api";

const CADENCES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];
const FORMATS = [
  { value: "csv", label: "CSV" },
  { value: "pdf", label: "PDF" },
];
const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, "0")}:00 UTC`,
}));

const EMPTY = {
  name: "",
  kind: "camera-uptime",
  cadence: "daily",
  export_format: "csv",
  hour_utc: 6,
  recipients: "",
  enabled: true,
};

export default function ReportScheduleModal({ open, schedule, reportKinds = [], onClose, onSaved }) {
  const editing = !!schedule;
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (schedule) {
      setForm({
        name: schedule.name || "",
        kind: schedule.kind || "camera-uptime",
        cadence: schedule.cadence || "daily",
        export_format: schedule.export_format || "csv",
        hour_utc: schedule.hour_utc ?? 6,
        recipients: (schedule.recipients || []).join(", "),
        enabled: schedule.enabled ?? true,
      });
    } else {
      setForm(EMPTY);
    }
  }, [open, schedule]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const kindOptions = reportKinds.map((k) => ({ value: k.value, label: k.label }));

  const save = async () => {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    const recipients = form.recipients
      .split(/[,\n]/)
      .map((r) => r.trim())
      .filter(Boolean);
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      cadence: form.cadence,
      export_format: form.export_format,
      hour_utc: Number(form.hour_utc),
      recipients,
      channel: "email",
      enabled: form.enabled,
    };
    setSaving(true);
    try {
      if (editing) {
        await vms.reports.schedules.update(schedule.id, body);
        toast.success("Schedule updated");
      } else {
        await vms.reports.schedules.create(body);
        toast.success("Schedule created");
      }
      onSaved?.();
    } catch (e) {
      toast.error(apiError(e, "Could not save the schedule"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit scheduled report" : "New scheduled report"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : editing ? "Save changes" : "Create schedule"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Name"
          placeholder="Weekly uptime digest"
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select label="Report" value={form.kind} onChange={(e) => set({ kind: e.target.value })} options={kindOptions} />
          <Select label="Cadence" value={form.cadence} onChange={(e) => set({ cadence: e.target.value })} options={CADENCES} />
          <Select label="Format" value={form.export_format} onChange={(e) => set({ export_format: e.target.value })} options={FORMATS} />
          <Select
            label="Run at"
            value={String(form.hour_utc)}
            onChange={(e) => set({ hour_utc: e.target.value })}
            options={HOURS}
          />
        </div>
        <Input
          label="Recipients (email, comma-separated)"
          placeholder="ops@example.com, security@example.com"
          value={form.recipients}
          onChange={(e) => set({ recipients: e.target.value })}
          hint="Delivered over email when the report runs."
        />
        <label className="flex items-center justify-between rounded-lg border border-card-border bg-hover/30 px-3 py-2.5">
          <span className="text-sm text-foreground">Enabled</span>
          <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} />
        </label>
      </div>
    </Modal>
  );
}
