// Security response headers on the frontend (HTML) tier — defence-in-depth
// alongside the backend middleware and the TLS reverse proxy. The authoritative
// Content-Security-Policy is set at the reverse proxy (where the real domain is
// known); these are the domain-independent OWASP/STQC baseline headers.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

// Next 16's dev server 403s every /_next/* request whose Origin isn't localhost
// (block-cross-site-dev). Opening the console on the machine's LAN IP therefore
// served the SSR HTML but no client bundle — the page rendered un-hydrated, so
// every mount-animated panel (login form, dashboard preview) stayed at opacity 0.
// Allow the private-network ranges so ONE dev server works from any LAN address;
// NEXT_DEV_ORIGINS adds hostnames (or `*.example.com`) on top. Dev-only knob —
// production builds ignore it.
// 127.0.0.1 is here for the DESKTOP SHELL. `localhost` is trusted by default and
// the loopback IP is not, which reads as a half-broken page rather than as a
// blocked request: the SSR HTML arrives so the login page's branding panel paints,
// the client bundle 403s so the page never hydrates, and every mount-animated
// element — the sign-in card included — stays at opacity 0. No error, anywhere.
// Verified: `Origin: http://localhost` → 200, `Origin: http://127.0.0.1` → 403.
const allowedDevOrigins = [
  "127.0.0.1",
  "192.168.*.*",
  "10.*.*.*",
  "172.*.*.*",
  ...(process.env.NEXT_DEV_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins,
  // Self-contained production build: `next build` emits `.next/standalone` with a
  // minimal `server.js` — the Docker runner stage ships that alone (no source, no
  // dev tooling). See frontend/Dockerfile.
  output: "standalone",
  // Next 16 runs on Turbopack by default. We have no custom bundler rules
  // (SVGs are rendered via @iconify at runtime, not imported as modules), so no
  // webpack/turbopack config is required.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

module.exports = nextConfig;
