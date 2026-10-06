// A recorder's API address as typed into Add recorder (SCRUM-302).

// The recorder console's own page routes, which an operator may paste with the address.
const CONSOLE_PAGES = /^\/(config|login|live|playback|home|events|alarms|settings|channels)(\/|$)/i;

/**
 * The recorder address as the backend wants it: http(s) with a host, no query,
 * fragment or trailing slash. An address copied from the browser's bar while on the
 * recorder's Federation page (…:8080/config?section=federation) keeps only its
 * origin, since no recorder API lives under a console page. Null when it is not an
 * http(s) URL at all, e.g. a bare "10.0.0.20:8080".
 */
export function normalizeApiUrl(raw: string): string | null {
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  if (url.search !== "" || url.hash !== "" || CONSOLE_PAGES.test(url.pathname)) return url.origin;
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  return `${url.origin}${path}`;
}
