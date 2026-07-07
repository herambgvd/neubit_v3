"use client";

import { Icon } from "@iconify/react";

// Placeholder landing for this scenario. Build the scenario's real views here
// (each a component in views/, wired to a route in app/(app)/ and to menu.js).
export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Icon icon="heroicons-outline:squares-2x2" className="text-5xl text-muted mb-4" />
      <h1 className="text-lg font-semibold text-foreground">Command Center</h1>
      <p className="text-sm text-muted mt-1 max-w-md">
        Scenario scaffold is ready. Build your features as components in
        <code className="mx-1 px-1 rounded bg-hover text-foreground">frontend/views/</code>
        and add them to <code className="mx-1 px-1 rounded bg-hover text-foreground">menu.js</code>.
      </p>
    </div>
  );
}
