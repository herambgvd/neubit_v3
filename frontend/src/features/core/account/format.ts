// Account-local formatters. Kept local (not the shared fmtDateTime) to preserve
// this view's full locale date-time strings and the UA → device label parsing.

// Friendly device label parsed from a User-Agent string.
export function deviceLabel(ua) {
  if (!ua) return "Unknown device";
  const os = /Windows/i.test(ua)
    ? "Windows"
    : /iPhone|iPad|iOS/i.test(ua)
    ? "iOS"
    : /Mac OS X|Macintosh/i.test(ua)
    ? "macOS"
    : /Android/i.test(ua)
    ? "Android"
    : /Linux/i.test(ua)
    ? "Linux"
    : "Unknown OS";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Chrome\//i.test(ua)
    ? "Chrome"
    : /Firefox\//i.test(ua)
    ? "Firefox"
    : /Safari\//i.test(ua)
    ? "Safari"
    : "Browser";
  return `${browser} on ${os}`;
}

export function fmt(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// Groups a base32 secret into 4-char blocks for easier manual entry.
export function groupSecret(s) {
  return (s || "").replace(/(.{4})/g, "$1 ").trim();
}
