/**
 * The receiver URL is the ONE string an integrator copies out of this console.
 * Getting it wrong does not fail loudly — the vendor posts to a URL that 404s and
 * nobody here sees anything. Two properties do all the work: the server's own
 * absolute `ingest_url` always wins (only it is correct outside this network),
 * and the fallback is built from the SLUG, not from any credential.
 */
import { describe, expect, it } from "vitest";

import { receiverUrl } from "./receiverUrl";

const ORIGIN = window.location.origin;

describe("receiverUrl", () => {
  it("uses the server's absolute URL verbatim, since only it is right off-network", () => {
    expect(receiverUrl("acme-door", "https://ingest.example.com/ingest/hooks/acme-door")).toBe(
      "https://ingest.example.com/ingest/hooks/acme-door",
    );
  });

  it("prefixes this origin onto a server-supplied relative path", () => {
    expect(receiverUrl("acme-door", "/ingest/hooks/acme-door")).toBe(
      `${ORIGIN}/ingest/hooks/acme-door`,
    );
  });

  it("builds the path from the slug when the server sent no URL at all", () => {
    expect(receiverUrl("acme-door", null)).toBe(`${ORIGIN}/ingest/hooks/acme-door`);
    expect(receiverUrl("acme-door")).toBe(`${ORIGIN}/ingest/hooks/acme-door`);
  });

  it("mounts the receiver at the root, never under the /api/v1 prefix", () => {
    expect(receiverUrl("acme-door")).not.toContain("/api/v1");
  });

  it("still produces a URL shaped like the real one when the slug is missing", () => {
    expect(receiverUrl(null, null)).toBe(`${ORIGIN}/ingest/hooks/`);
  });
});
