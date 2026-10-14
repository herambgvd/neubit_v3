"use client";

import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card, Toggle } from "@/components/ui/kit";
import AppearanceCard from "./AppearanceCard";
import EventAlertsCard from "@/features/vms/components/EventAlertsCard";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

function PrefRow({ title, desc, children }: Readonly<{ title: ReactNode; desc?: ReactNode; children?: ReactNode }>) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-card-border last:border-0 @3xl:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {desc && <div className="text-xs text-muted mt-0.5">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export default function PreferencesTab() {
  const { user, reload } = useAuth();
  const prefs = user?.preferences || {};

  // `PreferencesIn` — a partial merge; only the sent keys change.
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch("/auth/me/preferences", { preferences: patch }),
    onSuccess: async () => {
      await reload();
      toast.success("Preferences saved");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const notifyEmail = prefs.notify_email !== false; // default on
  const notifyInapp = prefs.notify_inapp !== false; // default on

  // One section under another, each the page's full width and laid out across
  // it, so no card leaves a hole beside a taller one. AppearanceCard owns the
  // theme, typeface and UI scale; it saves through lib/appearance, not through
  // the mutation above, because the choice has to apply before first paint.
  return (
    <div className="flex flex-col gap-6">
      <AppearanceCard />

      {/* Pop-ups and sound for alarms and plate hits — every event, one place. */}
      <EventAlertsCard />

      <Card className="@container p-6">
        <h2 className="text-sm font-semibold text-foreground mb-1">Notifications</h2>
        <div className="grid gap-x-10 @3xl:grid-cols-2">
          <PrefRow title="Email notifications" desc="Receive important alerts by email.">
            <Toggle
              checked={notifyEmail}
              onChange={(v) => save.mutate({ notify_email: v })}
              label="Email notifications"
            />
          </PrefRow>

          <PrefRow title="In-app notifications" desc="Show alerts in the notification center.">
            <Toggle
              checked={notifyInapp}
              onChange={(v) => save.mutate({ notify_inapp: v })}
              label="In-app notifications"
            />
          </PrefRow>
        </div>
      </Card>
    </div>
  );
}
