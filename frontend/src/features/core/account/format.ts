// Account-local formatters. Kept local (not the shared fmtDateTime) to preserve
// this view's full locale date-time strings and the UA → device label parsing.

// A User-Agent is matched in ORDER, not by best fit: the first row that hits
// wins. That is what keeps the overlaps right — every iPhone UA also says
// "Mac OS X", and Edge and Chrome both say "Chrome/". Reordering these rows
// relabels real sessions, so they are a list rather than a map.
const OS_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Windows/i, "Windows"],
  [/iPhone|iPad|iOS/i, "iOS"],
  [/Mac OS X|Macintosh/i, "macOS"],
  [/Android/i, "Android"],
  [/Linux/i, "Linux"],
];

const BROWSER_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//i, "Edge"],
  [/Chrome\//i, "Chrome"],
  [/Firefox\//i, "Firefox"],
  [/Safari\//i, "Safari"],
];

const firstMatch = (ua: string, rules: ReadonlyArray<readonly [RegExp, string]>, fallback: string): string =>
  rules.find(([re]) => re.test(ua))?.[1] ?? fallback;

// Friendly device label parsed from a User-Agent string.
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const os = firstMatch(ua, OS_RULES, "Unknown OS");
  const browser = firstMatch(ua, BROWSER_RULES, "Browser");
  return `${browser} on ${os}`;
}

export function fmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// Groups a base32 secret into 4-char blocks for easier manual entry.
export function groupSecret(s: string | null | undefined): string {
  return (s || "").replace(/(.{4})/g, "$1 ").trim();
}
