"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BadgeDollarSign,
  CircleDollarSign,
  Clock,
  CreditCard,
  Pencil,
  Plus,
  Receipt,
  Trash2,
  Users,
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
  StatCard,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@/components/ui";

function money(cents, currency = "USD") {
  const n = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

const INVOICE_TONE = {
  draft: "neutral",
  issued: "accent",
  paid: "success",
  overdue: "danger",
  void: "neutral",
};

export default function BillingPage() {
  const summaryQ = useQuery({ queryKey: ["billing", "summary"], queryFn: () => adminApi.billingSummary() });
  const s = summaryQ.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description="Subscription plans, tenant subscriptions and invoices — internal commercial records."
      />

      {/* Summary KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summaryQ.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)
        ) : (
          <>
            <StatCard
              label="MRR"
              value={money(s?.mrr_cents, s?.currency)}
              icon={CircleDollarSign}
              tone="accent"
              hint="Monthly recurring revenue"
            />
            <StatCard
              label="Active subscriptions"
              value={s?.active_subscriptions ?? 0}
              icon={CreditCard}
              hint={`${s?.plan_count ?? 0} plans in catalog`}
            />
            <StatCard
              label="Outstanding"
              value={money(s?.outstanding_cents, s?.currency)}
              icon={Receipt}
              tone={s?.outstanding_cents ? "warning" : "muted"}
              hint="Issued + overdue invoices"
            />
            <StatCard
              label="Overdue"
              value={s?.overdue_count ?? 0}
              icon={Clock}
              tone={s?.overdue_count ? "danger" : "muted"}
              hint={`${money(s?.paid_last_30d_cents, s?.currency)} paid (30d)`}
            />
          </>
        )}
      </div>

      <Tabs defaultValue="plans">
        <TabsList>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
        </TabsList>
        <TabsContent value="plans">
          <PlansTab />
        </TabsContent>
        <TabsContent value="invoices">
          <InvoicesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --- Plans -------------------------------------------------------------------
function PlansTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null); // plan object or {} for new
  const [deleting, setDeleting] = useState(null);

  const plansQ = useQuery({ queryKey: ["billing", "plans"], queryFn: () => adminApi.listPlans() });
  const plans = plansQ.data || [];

  const del = useMutation({
    mutationFn: (key) => adminApi.deletePlan(key),
    onSuccess: () => {
      toast.success("Plan deleted");
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing({})}>
          <Plus className="h-4 w-4" /> New plan
        </Button>
      </div>

      {plansQ.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}
        </div>
      ) : plans.length === 0 ? (
        <Card>
          <EmptyState
            icon={BadgeDollarSign}
            title="No plans yet"
            description="Create your first subscription tier — Starter, Pro, Enterprise — with a price and quotas."
            action={<Button onClick={() => setEditing({})}><Plus className="h-4 w-4" /> New plan</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((p) => (
            <Card key={p.key} className="flex flex-col p-5">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{p.name}</h3>
                    {!p.is_active && <Badge tone="neutral">Inactive</Badge>}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-muted">{p.key}</div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(p)} aria-label="Edit plan">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleting(p)} aria-label="Delete plan">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-2xl font-semibold tracking-tight text-foreground">{money(p.price_cents, p.currency)}</span>
                <span className="text-xs text-muted">/ {p.interval === "yearly" ? "yr" : "mo"}</span>
              </div>
              {p.description && <p className="mt-2 text-xs text-muted">{p.description}</p>}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {typeof p.limits?.max_users === "number" && (
                  <Badge tone="neutral"><Users className="h-3 w-3" /> {p.limits.max_users} users</Badge>
                )}
                {Object.entries(p.features || {})
                  .filter(([, v]) => v)
                  .slice(0, 4)
                  .map(([k]) => (
                    <Badge key={k} tone="accent">{k}</Badge>
                  ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <PlanDialog
          plan={editing.key ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["billing"] });
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? `Delete ${deleting.name}?` : ""}
        description="Tenants subscribed to this plan must be reassigned first. This cannot be undone."
        confirmLabel="Delete plan"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.key)}
      />
    </div>
  );
}

function PlanDialog({ plan, onClose, onSaved }) {
  const isEdit = !!plan;
  const [key, setKey] = useState(plan?.key || "");
  const [name, setName] = useState(plan?.name || "");
  const [description, setDescription] = useState(plan?.description || "");
  const [price, setPrice] = useState(plan ? String((plan.price_cents || 0) / 100) : "0");
  const [currency, setCurrency] = useState(plan?.currency || "USD");
  const [interval, setInterval] = useState(plan?.interval || "monthly");
  const [maxUsers, setMaxUsers] = useState(
    typeof plan?.limits?.max_users === "number" ? String(plan.limits.max_users) : ""
  );
  const [active, setActive] = useState(plan?.is_active ?? true);

  const save = useMutation({
    mutationFn: () => {
      const price_cents = Math.round((parseFloat(price) || 0) * 100);
      const limits = { ...(plan?.limits || {}) };
      if (maxUsers.trim() === "") delete limits.max_users;
      else limits.max_users = Number(maxUsers);
      const body = {
        name: name.trim(),
        description: description.trim(),
        price_cents,
        currency: currency.trim() || "USD",
        interval,
        limits,
        is_active: active,
      };
      if (isEdit) return adminApi.updatePlan(plan.key, body);
      return adminApi.createPlan({ ...body, key: key.trim(), features: plan?.features || {} });
    },
    onSuccess: () => {
      toast.success(isEdit ? "Plan updated" : "Plan created");
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader
          title={isEdit ? `Edit ${plan.name}` : "New plan"}
          description="Define a commercial tier. Quotas here are applied to a tenant when you assign this plan."
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return toast.error("Name is required");
            if (!isEdit && !/^[a-z0-9][a-z0-9_-]*$/.test(key.trim()))
              return toast.error("Key must be lowercase letters, numbers, - or _");
            save.mutate();
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key">
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="pro"
                disabled={isEdit}
                className="font-mono"
              />
            </Field>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pro" />
            </Field>
          </div>
          <Field label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="For growing teams" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Price">
              <Input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Field label="Currency">
              <Input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="USD" />
            </Field>
            <Field label="Interval">
              <Select value={interval} onValueChange={setInterval}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Max users quota (blank = unlimited)">
            <Input type="number" min={0} value={maxUsers} onChange={(e) => setMaxUsers(e.target.value)} placeholder="50" />
          </Field>
          <div className="flex items-center justify-between rounded-lg border border-card-border px-3 py-2.5">
            <div className="text-sm text-foreground">Active</div>
            <Switch checked={active} onCheckedChange={setActive} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{isEdit ? "Save changes" : "Create plan"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Invoices ----------------------------------------------------------------
function InvoicesTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [voiding, setVoiding] = useState(null);

  const invoicesQ = useQuery({
    queryKey: ["billing", "invoices", { status, q, page }],
    queryFn: () => adminApi.listInvoices({ status, q, page }),
    placeholderData: (prev) => prev,
  });
  const data = invoicesQ.data;
  const items = data?.items || [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["billing"] });

  const markPaid = useMutation({
    mutationFn: (id) => adminApi.markInvoicePaid(id),
    onSuccess: () => { toast.success("Invoice marked paid"); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const voidInv = useMutation({
    mutationFn: (id) => adminApi.voidInvoice(id),
    onSuccess: () => { toast.success("Invoice voided"); setVoiding(null); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="Search invoice #"
          className="max-w-xs"
        />
        <Select value={status || "all"} onValueChange={(v) => { setStatus(v === "all" ? "" : v); setPage(1); }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="issued">Issued</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
            <SelectItem value="void">Void</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="overflow-hidden">
        {invoicesQ.isLoading ? (
          <div className="p-4"><Skeleton className="h-40 rounded-lg" /></div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No invoices"
            description="Invoices you issue to tenants (from a tenant's Billing card) appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-card-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-medium">Invoice</th>
                  <th className="px-4 py-2.5 font-medium">Tenant</th>
                  <th className="px-4 py-2.5 font-medium">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Issued</th>
                  <th className="px-4 py-2.5 font-medium">Due</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {items.map((inv) => (
                  <tr key={inv.id} className="border-b border-card-border last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-foreground">{inv.number}</td>
                    <td className="px-4 py-2.5 text-muted">{inv.tenant_name || "—"}</td>
                    <td className="px-4 py-2.5 font-medium text-foreground">{money(inv.amount_cents, inv.currency)}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={INVOICE_TONE[inv.status] || "neutral"}>{inv.status}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{fmtDate(inv.issued_at)}</td>
                    <td className="px-4 py-2.5 text-muted">{fmtDate(inv.due_at)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1.5">
                        {inv.status !== "paid" && inv.status !== "void" && (
                          <Button
                            variant="outline"
                            size="sm"
                            loading={markPaid.isPending && markPaid.variables === inv.id}
                            onClick={() => markPaid.mutate(inv.id)}
                          >
                            Mark paid
                          </Button>
                        )}
                        {inv.status !== "void" && (
                          <Button variant="ghost" size="sm" onClick={() => setVoiding(inv)}>
                            Void
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {items.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted">
          <span>{data.total} invoices</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <span>Page {page} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!voiding}
        onOpenChange={(o) => !o && setVoiding(null)}
        title={voiding ? `Void ${voiding.number}?` : ""}
        description="A voided invoice is excluded from outstanding balances. This cannot be undone."
        confirmLabel="Void invoice"
        loading={voidInv.isPending}
        onConfirm={() => voiding && voidInv.mutate(voiding.id)}
      />
    </div>
  );
}
