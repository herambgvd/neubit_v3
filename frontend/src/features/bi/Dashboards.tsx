"use client";

// Building Intelligence → DASHBOARDS. The daily door to the dashboards this
// platform SHOWS.
//
// This surface used to list NeuBit-built dashboards and mount NeuBit's own
// viewer. It no longer does: DashForge is the single dashboarding surface, so
// what appears here is the set of DashForge dashboards REGISTERED on this
// platform, rendered through a short-lived embed token.
//
// WHAT WAS NOT DONE, AND MUST NOT BE DONE HERE. NeuBit's own builder — the
// `dashboards` service, its `/dashboards` routes, its data and its viewer — is
// deliberately left running and untouched. Removing it is a separate step and
// must not happen until this integration is proven in a real deployment; a
// migration that deletes the old surface on the same day the new one first boots
// has no way back. So the builder is still reachable at /dashboards and still
// gated by `dashboards.*`; nothing on this page touches it.
//
// Deliberately thin, for the same reason the previous version was:
//   • The strip is a MENU, not a manager. Authoring happens in DashForge.
//   • The selected id rides in `?d=`, so a dashboard here is a shareable LINK —
//     and note what that link carries: a registration id, never a token. Sharing
//     the URL shares a pointer, and the recipient's own `dashforge.read` is
//     re-checked before anything is minted for them.
//   • The first dashboard opens by default; a viewing surface that opens onto a
//     blank pane is the list page with extra steps.
//
// The one authoring affordance that IS here is REGISTER, gated by
// `dashforge.manage`. It is here because registration has no other home yet and
// a console that can only view a list nobody can add to is not usable. It
// records a pointer — which DashForge dashboard, under what name, with which
// filter values locked — and nothing about the dashboard's content.
//
// Permission shape:
//   dashforge.read   → this list, and the embed token that makes a dashboard
//                      render. Without it no token is ever minted, so the data
//                      is unreachable rather than merely hidden — DashForge's
//                      public embed route is unauthenticated and the token IS
//                      the credential.
//   dashforge.manage → registering and removing.
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ConsolePage,
  EmptyPane,
  EstateHeader,
  LoadingBlock,
} from "@/components/console";
import { Button, Input, Modal, Textarea } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import EmbedView from "@/features/dashforge/EmbedView";
import { dashforge, type DashForgeEmbed } from "@/features/dashforge/api";
import { PERM_MANAGE, PERM_READ } from "@/features/dashforge/constants";

const HEADER_DESC =
  "The DashForge dashboards registered on this platform. Pick a name to open it here — " +
  "this surface views; DashForge authors.";

function Strip({
  items,
  activeId,
  onPick,
}: {
  items: DashForgeEmbed[];
  activeId: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="mb-3 flex shrink-0 items-center gap-1.5 overflow-x-auto rounded-[10px] border border-nb-line bg-[rgba(8,15,34,.7)] p-1.5">
      {items.map((d) => {
        const on = d.id === activeId;
        return (
          <button
            key={d.id}
            onClick={() => onPick(d.id)}
            className={`shrink-0 rounded-[7px] px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              on
                ? "bg-nb-accent/15 text-nb-accent"
                : "text-nb-faint hover:bg-[rgba(255,255,255,.04)] hover:text-nb-ink"
            }`}
            title={d.description || d.name}
          >
            {d.name}
          </button>
        );
      })}
    </div>
  );
}

// The register form. `scope` is entered as plain `name=value` lines rather than
// JSON because it is a short list of filter bindings, and because a JSON textarea
// makes a typo a parse error instead of a missing lock.
//
// NeuBit does NOT validate the names: the lockable set is the DashForge
// dashboard's own global-filter control variables, which this platform has no
// view of. DashForge refuses an unlockable name at mint with a message naming
// it, and that message is surfaced verbatim — checking it here would mean
// guessing, and a guess that says "fine" when DashForge says "no" is worse than
// no check.
function parseScope(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function RegisterModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspaceRef, setWorkspaceRef] = useState("");
  const [dashboardRef, setDashboardRef] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      dashforge.register({
        name: name.trim(),
        description: description.trim() || null,
        workspace_ref: workspaceRef.trim(),
        dashboard_ref: dashboardRef.trim(),
        scope: parseScope(scopeText),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashforge", "list"] });
      onClose();
    },
    onError: (e) => setError(apiError(e, "Could not register that dashboard")),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register a DashForge dashboard"
      subtitle="Records a pointer and a name. The dashboard itself stays in DashForge."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setError(null);
              save.mutate();
            }}
            disabled={!name.trim() || !workspaceRef.trim() || !dashboardRef.trim() || save.isPending}
          >
            {save.isPending ? "Registering…" : "Register"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          label="Name"
          required
          value={name}
          onChange={(e: any) => setName(e.target.value)}
          hint="What operators call it here. Independent of its title in DashForge on purpose — a rename on either side should not silently change the other's navigation."
        />
        <Textarea
          label="Description"
          rows={2}
          value={description}
          onChange={(e: any) => setDescription(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="DashForge workspace id"
            required
            value={workspaceRef}
            onChange={(e: any) => setWorkspaceRef(e.target.value)}
          />
          <Input
            label="DashForge dashboard id"
            required
            value={dashboardRef}
            onChange={(e: any) => setDashboardRef(e.target.value)}
          />
        </div>
        <Textarea
          label="Locked filters"
          rows={3}
          placeholder="site_id=42"
          value={scopeText}
          onChange={(e: any) => setScopeText(e.target.value)}
        />
        <p className="text-[11px] leading-relaxed text-nb-faint">
          One <span className="font-mono">name=value</span> per line. These are baked into the embed
          token&apos;s signature: a viewer can neither change one nor widen the view by leaving it
          out. Only a dashboard&apos;s global-filter controls can be locked, and DashForge refuses
          to mint if a widget&apos;s query ignores the lock — so an empty box means every viewer of
          this dashboard sees every row it can reach.
        </p>
        {error && <p className="text-[11.5px] text-nb-crit">{error}</p>}
      </div>
    </Modal>
  );
}

function BIDashboardsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [registering, setRegistering] = useState(false);

  const listQ = useQuery({
    queryKey: ["dashforge", "list"],
    queryFn: () => dashforge.list(),
    enabled: can(PERM_READ),
  });

  const remove = useMutation({
    mutationFn: (id: string) => dashforge.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashforge", "list"] }),
  });

  const registerAction = can(PERM_MANAGE) ? (
    <Button icon="heroicons:plus" onClick={() => setRegistering(true)}>
      Register
    </Button>
  ) : null;

  if (!can(PERM_READ)) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={[{ label: "Dashboards" }]} desc={HEADER_DESC} />
        <EmptyPane
          icon="heroicons:lock-closed"
          title="No dashboard access"
          subtitle="Viewing DashForge dashboards needs the `dashforge.read` permission — this account does not hold it. Without it no embed token is minted, so the data is unreachable, not merely hidden."
        />
      </ConsolePage>
    );
  }

  if (listQ.isLoading) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={[{ label: "Dashboards" }]} desc={HEADER_DESC} />
        <LoadingBlock label="Listing dashboards…" />
      </ConsolePage>
    );
  }

  const items: DashForgeEmbed[] = listQ.data?.items ?? [];

  if (items.length === 0) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={[{ label: "Dashboards" }]} desc={HEADER_DESC} right={registerAction} />
        <EmptyPane
          icon="heroicons:squares-2x2"
          title="No dashboards registered"
          subtitle={
            can(PERM_MANAGE)
              ? "Build a dashboard in DashForge, then register it here with its workspace and dashboard id."
              : "Nothing has been registered yet. An account holding `dashforge.manage` chooses which DashForge dashboards appear here."
          }
        />
        <RegisterModal open={registering} onClose={() => setRegistering(false)} />
      </ConsolePage>
    );
  }

  // `?d=` names the open dashboard; absent or unknown falls back to the first,
  // so the surface always opens onto something rather than a blank pane.
  const asked = params.get("d");
  const active = (asked && items.find((d) => d.id === asked)) || items[0];

  return (
    <ConsolePage>
      <EstateHeader
        crumbs={[{ label: "Dashboards" }]}
        desc={HEADER_DESC}
        right={
          <div className="flex items-center gap-2">
            {can(PERM_MANAGE) && (
              <Button
                variant="danger"
                icon="heroicons:trash"
                disabled={remove.isPending}
                onClick={() => {
                  // Removes the REGISTRATION only. The dashboard stays in
                  // DashForge, and outstanding tokens are left to expire rather
                  // than revoked — DashForge's revoke is dashboard-wide and would
                  // break every other consumer of it.
                  if (window.confirm(`Remove "${active.name}" from this console? The dashboard itself stays in DashForge.`)) {
                    remove.mutate(active.id);
                  }
                }}
              >
                Remove
              </Button>
            )}
            {registerAction}
          </div>
        }
      />
      <Strip
        items={items}
        activeId={active.id}
        onPick={(id) => router.replace(`/bi/dashboards?d=${id}`, { scroll: false })}
      />
      {/* keyed so switching dashboards mints a fresh session and remounts the
          frame clean — one dashboard's token must never render another's */}
      <EmbedView key={active.id} id={active.id} name={active.name} />
      <RegisterModal open={registering} onClose={() => setRegistering(false)} />
    </ConsolePage>
  );
}

export default function BIDashboards() {
  // useSearchParams needs a Suspense boundary in Next 16.
  return (
    <Suspense fallback={<LoadingBlock label="Listing dashboards…" />}>
      <BIDashboardsInner />
    </Suspense>
  );
}
