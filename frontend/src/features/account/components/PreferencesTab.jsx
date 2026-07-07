"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card, Toggle } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/components/theme";

function PrefRow({ title, desc, children }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-card-border last:border-0">
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
  const { theme, toggle } = useTheme();
  const prefs = user?.preferences || {};

  const save = useMutation({
    mutationFn: (patch) => api.patch("/auth/me/preferences", { preferences: patch }),
    onSuccess: async () => {
      await reload();
      toast.success("Preferences saved");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const notifyEmail = prefs.notify_email !== false; // default on
  const notifyInapp = prefs.notify_inapp !== false; // default on

  return (
    <div className="grid gap-6 lg:grid-cols-2 items-start">
      <Card className="p-6">
        <h2 className="text-sm font-semibold text-foreground mb-1">Appearance</h2>
        <PrefRow title="Theme" desc="Choose how the interface looks on this device.">
          <div className="flex items-center gap-1 rounded-md border border-card-border p-1">
            {["light", "dark"].map((t) => (
              <button
                key={t}
                onClick={() => {
                  if (theme !== t) toggle();
                  save.mutate({ theme: t });
                }}
                className={`px-3 py-1 rounded text-xs font-medium capitalize transition ${
                  theme === t ? "bg-hover text-foreground" : "text-muted hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </PrefRow>
      </Card>

      <Card className="p-6">
        <h2 className="text-sm font-semibold text-foreground mb-1">Notifications</h2>
        <PrefRow title="Email notifications" desc="Receive important alerts by email.">
          <Toggle checked={notifyEmail} onChange={(v) => save.mutate({ notify_email: v })} />
        </PrefRow>

        <PrefRow title="In-app notifications" desc="Show alerts in the notification center.">
          <Toggle checked={notifyInapp} onChange={(v) => save.mutate({ notify_inapp: v })} />
        </PrefRow>
      </Card>
    </div>
  );
}
