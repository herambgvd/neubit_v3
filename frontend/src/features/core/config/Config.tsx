"use client";

// Config — the Platform view for how this deployment presents itself and how it
// reaches people.
//
// It was two segments, Branding and Notifications, and they are one subject read
// twice: the name, colour and logo appear on the login page AND on every email
// that leaves here, and the delivery channels are what carries those emails. An
// admin white-labelling a deployment was switching tabs to finish one job.
//
// APPEARANCE IS HERE TOO, AND IT IS NOT PLATFORM-WIDE. The typeface and text size
// are a PER-USER preference — they change the console of whoever is signed in,
// not the tenant's. It sits here because an admin dressing a deployment reaches
// for it in the same sitting, and it stays in My account → Preferences as well,
// because an operator without `settings.manage` cannot open this page at all and
// still has to be able to set their own. Same component in both places, so the
// two cannot drift.
import AppearanceCard from "@/features/core/account/components/AppearanceCard";
import Branding from "@/features/core/branding/Branding";
import Channels from "@/features/core/notifications/Channels";

export default function ConfigPage() {
  return (
    <div className="space-y-4">
      <Branding />
      <Channels />
      <AppearanceCard />
    </div>
  );
}
