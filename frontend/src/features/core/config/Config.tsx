"use client";

// Config — one Platform view for how this deployment presents itself and how it
// reaches people.
//
// It was two segments, Branding and Notifications, and they are one subject read
// twice: the name, colour and logo appear on the login page AND on every email
// that leaves here, and the delivery channels are what carries those emails. An
// admin white-labelling a deployment was switching tabs to finish one job.
//
// Two bands, in the order the work happens: what it is CALLED, then how it REACHES
// people.
import { Icon } from "@iconify/react";

import Branding from "@/features/core/branding/Branding";
import Channels from "@/features/core/notifications/Channels";

function Band({ icon, title, note }: { icon: string; title: string; note: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Icon icon={icon} className="text-sm text-nb-blueb" />
      <h2 className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">{title}</h2>
      <span className="text-[11px] text-nb-faint">{note}</span>
    </div>
  );
}

export default function ConfigPage() {
  return (
    <div className="space-y-6">
      <section>
        <Band
          icon="heroicons-outline:swatch"
          title="Identity"
          note="the name, colour and logo this deployment signs itself with"
        />
        <Branding />
      </section>

      <section>
        <Band
          icon="heroicons-outline:paper-airplane"
          title="Delivery"
          note="how messages leave the platform"
        />
        <Channels />
      </section>
    </div>
  );
}
