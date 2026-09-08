"use client";

// Renewal — behind a button, not open on the page.
//
// A textarea sitting open under everything else reads as a form waiting to be
// filled in, on a screen most people open to READ a licence. Same rule as the
// rest of the console: the form appears when you say you have something to
// apply. Presentational — the parent owns the token state and the mutation.
import { useState } from "react";

import { ActionButton, SectionCard, SectionHead } from "@/components/console";
import { Button, Textarea } from "@/components/ui/kit";

export interface UpdateLicensePanelProps {
  token: string;
  setToken: (value: string) => void;
  onApply: () => void;
  applying: boolean;
}

export default function UpdateLicensePanel({
  token,
  setToken,
  onApply,
  applying,
}: UpdateLicensePanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <SectionCard className="space-y-3">
      <SectionHead
        icon="heroicons-outline:key"
        title="Renewal"
        desc="A signed token is verified and hot-swapped instantly. An expired one is refused."
      />

      {open ? (
        <>
          <Textarea
            label="Signed license token"
            rows={7}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your signed license token here…"
            className="font-mono text-xs"
          />
          <div className="flex gap-2">
            <ActionButton
              icon="heroicons-outline:key"
              className="flex-1 justify-center"
              disabled={applying || !token.trim()}
              onClick={onApply}
            >
              {applying ? "Applying…" : "Apply"}
            </ActionButton>
            <Button
              variant="secondary"
              onClick={() => {
                setToken("");
                setOpen(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <ActionButton
          icon="heroicons-outline:arrow-up-tray"
          className="w-full justify-center"
          onClick={() => setOpen(true)}
        >
          Apply a license token
        </ActionButton>
      )}
    </SectionCard>
  );
}
