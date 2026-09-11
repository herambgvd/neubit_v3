import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { Branding, PlatformSettings } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import PlatformSettingsPage from "./page";

const settings = (values: Record<string, unknown>): PlatformSettings => ({
  catalog: [],
  values,
});

const branding: Branding = {
  id: "b1",
  app_name: "Neubit",
  logo_url: null,
  favicon_url: null,
};

beforeEach(() => {
  // mockImplementation, not mockResolvedValue: a real fetch returns a NEW object
  // each time, and object identity is exactly what the old effect-sync keyed off.
  // Returning one shared object would hide the bug this file is here to catch.
  vi.spyOn(adminApi, "getPlatformSettings").mockImplementation(async () =>
    settings({
      announcement: "Scheduled maintenance",
      support_email: "help@neubit",
      allow_signups: false,
    })
  );
  vi.spyOn(adminApi, "getPlatformBranding").mockImplementation(async () => ({ ...branding }));
});

describe("platform settings", () => {
  it("seeds each form from the stored values", async () => {
    renderWithProviders(<PlatformSettingsPage />);

    expect(await screen.findByDisplayValue("Scheduled maintenance")).toBeInTheDocument();
    expect(screen.getByDisplayValue("help@neubit")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Neubit")).toBeInTheDocument();
  });

  // Regression: the forms synced server data into their state in an effect, so a
  // refetch that came back CHANGED — another admin saving, or this page's own
  // post-save invalidate — replaced whatever the operator was typing. (A refetch
  // with identical content never did: React Query's structural sharing keeps the
  // previous object, so the effect's dependency never changed. The narrower case
  // is the real one, and it is the one reproduced here.) Each form now seeds from
  // props once and owns its state afterwards.
  it("does not overwrite in-progress edits when the settings change under it", async () => {
    let stored = "help@neubit";
    vi.spyOn(adminApi, "getPlatformSettings").mockImplementation(async () =>
      settings({
        announcement: "Scheduled maintenance",
        support_email: stored,
        allow_signups: false,
      })
    );

    const { client } = renderWithProviders(<PlatformSettingsPage />);
    const input = await screen.findByDisplayValue("help@neubit");

    await userEvent.clear(input);
    await userEvent.type(input, "ops@neubit");

    // Someone else saves a different value, and the query refetches.
    stored = "someone-else@neubit";
    await client.refetchQueries({ queryKey: ["platform", "settings"] });

    // Wait for the NEW data to be in the cache and rendered from, so the
    // assertion below cannot pass merely by running before the re-render — that
    // race is what made an earlier version of this test unable to fail.
    await waitFor(() =>
      expect(client.getQueryData<PlatformSettings>(["platform", "settings"])?.values)
        .toMatchObject({ support_email: "someone-else@neubit" })
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(input).toHaveValue("ops@neubit");
  });

  it("coerces a non-string stored value instead of rendering [object Object]", async () => {
    vi.spyOn(adminApi, "getPlatformSettings").mockImplementation(async () =>
      settings({ support_email: 42, announcement: null })
    );

    renderWithProviders(<PlatformSettingsPage />);

    expect(await screen.findByDisplayValue("42")).toBeInTheDocument();
  });

  it("sends only the settings this card owns", async () => {
    const update = vi
      .spyOn(adminApi, "updatePlatformSettings")
      .mockImplementation(async () => settings({}));

    renderWithProviders(<PlatformSettingsPage />);
    const input = await screen.findByDisplayValue("help@neubit");
    await userEvent.clear(input);
    await userEvent.type(input, "ops@neubit");
    // The first Save belongs to the platform-settings card.
    await userEvent.click(screen.getAllByRole("button", { name: /^save$/i })[0]!);

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        values: {
          announcement: "Scheduled maintenance",
          support_email: "ops@neubit",
          allow_avatar_uploads: false,
          allow_signups: false,
        },
      })
    );
  });

  it("reports a failed load instead of an empty form", async () => {
    vi.spyOn(adminApi, "getPlatformSettings").mockRejectedValue(new Error("core unreachable"));

    renderWithProviders(<PlatformSettingsPage />);

    expect((await screen.findAllByText(/core unreachable/i)).length).toBeGreaterThan(0);
  });
});
