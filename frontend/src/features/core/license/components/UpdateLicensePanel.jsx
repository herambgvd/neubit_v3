"use client";

// Right column of the License page: paste + apply a signed license token.
// Presentational — the parent owns the token state and apply mutation.
import { ActionButton, SectionCard, SectionHead } from "@/components/console";
import { Textarea } from "@/components/ui/kit";

export default function UpdateLicensePanel({ token, setToken, onApply, applying }) {
  return (
    <SectionCard className="space-y-3">
      <SectionHead icon="heroicons-outline:key" title="Update license" />
      <Textarea
        label="Signed license token"
        rows={8}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Paste your signed license token here…"
        className="font-mono text-xs"
      />
      <ActionButton
        icon="heroicons-outline:key"
        className="w-full justify-center"
        disabled={applying || !token.trim()}
        onClick={onApply}
      >
        {applying ? "Applying…" : "Apply"}
      </ActionButton>
      <p className="text-[11.5px] leading-relaxed text-nb-faint">
        The token is verified and hot-swapped instantly. Expired tokens are rejected.
      </p>
    </SectionCard>
  );
}
