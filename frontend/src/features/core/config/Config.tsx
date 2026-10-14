"use client";

// Config — the Platform view for how this deployment presents itself and how it
// reaches people.
//
// It was two segments, Branding and Notifications, and they are one subject read
// twice: the name, colour and logo appear on the login page AND on every email
// that leaves here, and the delivery channels are what carries those emails. An
// admin white-labelling a deployment was switching tabs to finish one job.
//
// APPEARANCE IS NOT HERE. Theme, typeface and text size are a PER-USER
// preference — they change the console of whoever is signed in, not the
// tenant's — so they live in one place, My account → Preferences, which every
// operator can open. Showing the same card here too put one setting on two pages
// and made this one read as if it dressed the whole deployment.
import Branding from "@/features/core/branding/Branding";
import Channels from "@/features/core/notifications/Channels";

export default function ConfigPage() {
  return (
    <div className="space-y-4">
      <Branding />
      <Channels />
    </div>
  );
}
