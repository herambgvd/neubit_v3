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

// Same LAN-IP dev fix as frontend/next.config.js — Next 16 blocks /_next/* for any
// non-localhost Origin, which leaves the page un-hydrated. See that file for detail.
const allowedDevOrigins = [
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
  // Self-contained production build (see admin-frontend/Dockerfile).
  output: "standalone",
  // Next 16 runs on Turbopack by default. No custom bundler rules are needed.
  //
  // `root` IS needed, though. Turbopack infers a workspace root by walking up
  // from the entry it is compiling, and in the dev container it settled on
  // /app/src/app — from which next/package.json is not resolvable, so a compile
  // that had already served a 200 died with "We couldn't find the Next.js
  // package". Pinning the root to this directory removes the inference.
  //
  // The sibling console does not need this, which is what makes it easy to
  // mistake for an environment problem rather than a missing config.
  turbopack: { root: __dirname },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

module.exports = nextConfig;
