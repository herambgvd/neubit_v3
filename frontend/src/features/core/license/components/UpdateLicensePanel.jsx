"use client";

// Right column of the License page: paste + apply a signed license token.
// Presentational — the parent owns the token state and apply mutation.
import { Button, Card, Textarea } from "@/components/ui/kit";

export default function UpdateLicensePanel({ token, setToken, onApply, applying }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted mb-2">
        Update license
      </p>
      <Card className="p-6 space-y-4">
        <Textarea
          label="Signed license token"
          rows={8}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste your signed license token here…"
          className="font-mono text-xs"
        />
        <Button
          icon="heroicons-outline:key"
          className="w-full"
          disabled={applying || !token.trim()}
          onClick={onApply}
        >
          {applying ? "Applying…" : "Apply"}
        </Button>
        <p className="text-xs text-muted">
          The token is verified and hot-swapped instantly. Expired tokens are rejected.
        </p>
      </Card>
    </div>
  );
}
