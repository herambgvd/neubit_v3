"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CircleAlert,
  Info,
  Megaphone,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Textarea,
} from "@/components/ui";

const SEVERITY = {
  critical: { tone: "danger", Icon: CircleAlert, chip: "bg-danger/15 text-danger" },
  warning: { tone: "warning", Icon: AlertTriangle, chip: "bg-warning/15 text-warning" },
  info: { tone: "accent", Icon: Info, chip: "bg-accent/15 text-accent" },
};

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function windowLabel(b) {
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : null);
  const s = fmt(b.starts_at);
  const e = fmt(b.ends_at);
  if (!s && !e) return "Always on";
  if (s && e) return `${s} → ${e}`;
  if (s) return `From ${s}`;
  return `Until ${e}`;
}

export default function BroadcastsPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const listQ = useQuery({ queryKey: ["broadcasts"], queryFn: () => adminApi.listBroadcasts() });
  const items = listQ.data || [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ["broadcasts"] });

  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }) => adminApi.updateBroadcast(id, { is_active }),
    onSuccess: invalidate,
    onError: (e) => toast.error(apiError(e)),
  });
  const del = useMutation({
    mutationFn: (id) => adminApi.deleteBroadcast(id),
    onSuccess: () => { toast.success("Broadcast deleted"); setDeleting(null); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Broadcasts"
          description="Platform-wide announcements pushed to tenant consoles — scheduled and targeted."
        />
        <Button onClick={() => setEditing({})}>
          <Plus className="h-4 w-4" /> New broadcast
        </Button>
      </div>

      {listQ.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Megaphone}
            title="No broadcasts"
            description="Announce maintenance windows, new features or notices to some or all tenants."
            action={<Button onClick={() => setEditing({})}><Plus className="h-4 w-4" /> New broadcast</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((b) => {
            const sev = SEVERITY[b.severity] || SEVERITY.info;
            return (
              <Card key={b.id} className="p-4">
                <div className="flex items-start gap-3">
                  <span className={"mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg " + sev.chip}>
                    <sev.Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{b.title}</span>
                      <Badge tone={sev.tone}>{b.severity}</Badge>
                      <Badge tone="neutral">
                        {b.target_type === "all" ? "All tenants" : `${b.target_tenant_ids.length} tenant(s)`}
                      </Badge>
                      {!b.is_active && <Badge tone="neutral">Inactive</Badge>}
                    </div>
                    {b.body && <p className="mt-1 text-xs text-muted">{b.body}</p>}
                    <p className="mt-1.5 text-[11px] text-muted">{windowLabel(b)}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <label className="mr-1 flex items-center" title={b.is_active ? "Active" : "Inactive"}>
                      <Switch
                        checked={b.is_active}
                        onCheckedChange={(v) => toggleActive.mutate({ id: b.id, is_active: v })}
                      />
                    </label>
                    <Button variant="ghost" size="icon" onClick={() => setEditing(b)} aria-label="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleting(b)} aria-label="Delete">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <BroadcastDialog
          broadcast={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate(); }}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? `Delete “${deleting.title}”?` : ""}
        description="This removes the announcement from tenant consoles immediately."
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
    </div>
  );
}

function BroadcastDialog({ broadcast, onClose, onSaved }) {
  const isEdit = !!broadcast;
  const [title, setTitle] = useState(broadcast?.title || "");
  const [body, setBody] = useState(broadcast?.body || "");
  const [severity, setSeverity] = useState(broadcast?.severity || "info");
  const [targetType, setTargetType] = useState(broadcast?.target_type || "all");
  const [targets, setTargets] = useState(broadcast?.target_tenant_ids || []);
  const [startsAt, setStartsAt] = useState(toLocalInput(broadcast?.starts_at));
  const [endsAt, setEndsAt] = useState(toLocalInput(broadcast?.ends_at));
  const [active, setActive] = useState(broadcast?.is_active ?? true);

  const tenantsQ = useQuery({
    queryKey: ["tenants", "all-for-broadcast"],
    queryFn: () => adminApi.listTenants({ pageSize: 100 }),
    enabled: targetType === "tenants",
  });
  const tenants = useMemo(() => {
    const rows = tenantsQ.data?.items ?? tenantsQ.data;
    return Array.isArray(rows) ? rows : [];
  }, [tenantsQ.data]);

  const toggleTarget = (id) =>
    setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        title: title.trim(),
        body: body.trim(),
        severity,
        target_type: targetType,
        target_tenant_ids: targetType === "tenants" ? targets : [],
        starts_at: startsAt ? new Date(startsAt).toISOString() : null,
        ends_at: endsAt ? new Date(endsAt).toISOString() : null,
        is_active: active,
      };
      if (isEdit) return adminApi.updateBroadcast(broadcast.id, payload);
      return adminApi.createBroadcast(payload);
    },
    onSuccess: () => { toast.success(isEdit ? "Broadcast updated" : "Broadcast created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader
          title={isEdit ? "Edit broadcast" : "New broadcast"}
          description="Shown as a banner in the operator console of targeted tenants during its window."
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return toast.error("Title is required");
            if (targetType === "tenants" && targets.length === 0)
              return toast.error("Select at least one tenant");
            save.mutate();
          }}
          className="space-y-4"
        >
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Scheduled maintenance" autoFocus />
          </Field>
          <Field label="Message">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="We'll be performing maintenance this weekend…" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Severity">
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Audience">
              <Select value={targetType} onValueChange={setTargetType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tenants</SelectItem>
                  <SelectItem value="tenants">Specific tenants</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {targetType === "tenants" && (
            <Field label="Tenants">
              {tenantsQ.isLoading ? (
                <Skeleton className="h-24 rounded-lg" />
              ) : (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-card-border p-2">
                  {tenants.map((t) => (
                    <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-hover">
                      <input
                        type="checkbox"
                        checked={targets.includes(t.id)}
                        onChange={() => toggleTarget(t.id)}
                        className="accent-accent"
                      />
                      <span className="text-foreground">{t.name}</span>
                      <span className="font-mono text-xs text-muted">{t.slug}</span>
                    </label>
                  ))}
                  {tenants.length === 0 && <p className="px-2 py-1 text-xs text-muted">No tenants.</p>}
                </div>
              )}
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts (blank = now)">
              <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </Field>
            <Field label="Ends (blank = open)">
              <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </Field>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-card-border px-3 py-2.5">
            <div className="text-sm text-foreground">Active</div>
            <Switch checked={active} onCheckedChange={setActive} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{isEdit ? "Save changes" : "Create broadcast"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
