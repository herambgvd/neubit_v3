import { toast } from "sonner";

// Build the public receiver URL shown to integrators.
//
// Prefer the server's `ingest_url` — this mirrors v2, where the URL was built
// server-side from a configured base origin and the UI just rendered it. When
// VE_INGEST_PUBLIC_BASE_URL is set the backend returns an absolute URL, which is
// the only value that is correct for an integrator outside this network.
//
// The origin fallback is right when the operator reaches the UI through the
// gateway (:80 — Traefik routes /ingest/hooks straight to the ingest service)
// and WRONG on the :3000 dev server, where that path hits Next.js instead.
//
// NOTE: the receiver is mounted at ROOT (/ingest/hooks/{slug}), NOT under the
// /api/v1 prefix.
export function receiverUrl(slug, ingestUrl) {
  if (ingestUrl && /^https?:\/\//i.test(ingestUrl)) return ingestUrl;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${ingestUrl || `/ingest/hooks/${slug || ""}`}`;
}

export function copyToClipboard(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Could not copy"),
    );
  }
}
