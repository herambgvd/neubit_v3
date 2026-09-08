/**
 * The Platform console picks its view off `?view=`. Two of those keys —
 * `branding` and `notifications` — became one view, and the FALLBACK is what
 * carries them: a bookmark sent round before the merge still lands on the page
 * holding what it asked for.
 *
 * The first version of this file added explicit alias entries for those two keys
 * and tested them. Deleting the aliases did not fail a single case — the fallback
 * had them covered all along — so the entries were dead code that read as if they
 * were doing the work. What is tested now is the property that actually holds.
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import PlatformConsole from "./PlatformConsole";

const search = { value: "" };
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "me" }, can: () => true, hasModule: () => true }),
}));

beforeEach(() => {
  search.value = "";
  stubApi({
    "GET /branding": { app_name: "Acme", primary_color: "#4f46e5", accent_color: "#22d3ee" },
    "GET /messaging/channels": [{ channel: "email", enabled: true, config: {} }],
  });
});

describe("the Platform console's view keys", () => {
  it("opens on Communications when no view is asked for", async () => {
    expect(await open()).toBe(true);
  });

  it("carries the retired ?view=branding link to the view that replaced it", async () => {
    search.value = "view=branding";
    expect(await open()).toBe(true);
  });

  it("carries the retired ?view=notifications link the same way", async () => {
    search.value = "view=notifications";
    expect(await open()).toBe(true);
  });

  it("falls back rather than rendering nothing for a key that never existed", async () => {
    search.value = "view=nonsense";
    expect(await open()).toBe(true);
  });

  async function open() {
    renderWithProviders(<PlatformConsole />);
    // Both bands of the merged view, which no other Platform view renders.
    await screen.findByText("Identity");
    await screen.findByText("Delivery");
    return true;
  }
});
