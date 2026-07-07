"use client";

import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";

export default function RecoveryCodes({ codes, onClose }) {
  return (
    <div className="rounded-md border border-card-border bg-hover/40 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <Icon icon="heroicons-outline:key" className="text-base text-amber-500 mt-0.5 shrink-0" />
        <div>
          <div className="text-sm font-medium text-foreground">Save your recovery codes</div>
          <p className="text-xs text-muted mt-0.5">
            Each code works once if you lose your authenticator. Store them somewhere safe — they
            won&apos;t be shown again.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 font-mono text-[13px] text-foreground">
        {codes.map((c) => (
          <div key={c} className="rounded bg-card border border-card-border px-2 py-1 text-center">
            {c}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          icon="heroicons-outline:clipboard-document"
          onClick={() => {
            navigator.clipboard?.writeText(codes.join("\n"));
            toast.success("Recovery codes copied");
          }}
        >
          Copy all
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
