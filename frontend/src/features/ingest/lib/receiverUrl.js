import { toast } from "sonner";

// Build the public receiver URL shown to integrators (backend serves it).
// NOTE: the receiver is mounted at ROOT (/ingest/hooks/{token}), NOT under the
// /api/v1 prefix — the gateway routes /ingest/hooks straight to the ingest service.
export function receiverUrl(token) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/ingest/hooks/${token || ""}`;
}

export function copyToClipboard(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Could not copy"),
    );
  }
}
