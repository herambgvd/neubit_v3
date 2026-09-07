/**
 * The rule under test is the one that is easy to get wrong: TWO stores hold the
 * same choice, and local must win. If the server value could override a local
 * pick, the console would visibly change font a second after every login.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";

import { AppearanceProvider, FONT_PREF_KEY, SCALE_PREF_KEY, useAppearance } from "./appearance";
import {
  DEFAULT_FONT,
  DEFAULT_SCALE,
  FONT_STORAGE_KEY,
  SCALE_STORAGE_KEY,
  parseFont,
  parseScale,
} from "./fonts/catalog";

let currentUser: { preferences?: Record<string, unknown> } | null = null;
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: currentUser }) }));

function Probe() {
  const { font, scale, setFont, setScale } = useAppearance();
  return (
    <div>
      <span data-testid="state">{`${font}/${scale}`}</span>
      <button type="button" onClick={() => setFont("inter")}>
        inter
      </button>
      <button type="button" onClick={() => setScale("xl")}>
        xl
      </button>
    </div>
  );
}

function mount() {
  render(
    <AppearanceProvider>
      <Probe />
    </AppearanceProvider>,
  );
}

let http: ApiStub;

beforeEach(() => {
  currentUser = null;
  localStorage.clear();
  document.documentElement.removeAttribute("data-font");
  document.documentElement.removeAttribute("data-ui-scale");
  http = stubApi({ "PATCH /auth/me/preferences": () => ({ id: "u1" }) });
});

describe("the catalogue", () => {
  it("falls back rather than trusting a value it does not know", () => {
    expect(parseFont("outfit")).toBe("outfit");
    expect(parseFont("comic-sans")).toBe(DEFAULT_FONT);
    expect(parseFont(undefined)).toBe(DEFAULT_FONT);
    expect(parseScale("xl")).toBe("xl");
    expect(parseScale("huge")).toBe(DEFAULT_SCALE);
  });
});

describe("AppearanceProvider", () => {
  it("starts on the catalogue defaults and stamps them on <html>", async () => {
    mount();

    expect(screen.getByTestId("state")).toHaveTextContent(`${DEFAULT_FONT}/${DEFAULT_SCALE}`);
    await waitFor(() => expect(document.documentElement.dataset.font).toBe(DEFAULT_FONT));
    expect(document.documentElement.dataset.uiScale).toBe(DEFAULT_SCALE);
  });

  it("restores what this device already chose", async () => {
    localStorage.setItem(FONT_STORAGE_KEY, "dmSans");
    localStorage.setItem(SCALE_STORAGE_KEY, "lg");

    mount();

    expect(screen.getByTestId("state")).toHaveTextContent("dmSans/lg");
    await waitFor(() => expect(document.documentElement.dataset.font).toBe("dmSans"));
  });

  it("applies a change, keeps it locally, and sends it to the signed-in user", async () => {
    currentUser = { preferences: {} };
    mount();

    await userEvent.click(screen.getByRole("button", { name: "inter" }));

    expect(screen.getByTestId("state")).toHaveTextContent("inter/");
    await waitFor(() => expect(document.documentElement.dataset.font).toBe("inter"));
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("inter");
    await waitFor(() =>
      expect(http.body("PATCH /auth/me/preferences")).toEqual({ preferences: { [FONT_PREF_KEY]: "inter" } }),
    );
  });

  it("saves the scale under its own key", async () => {
    currentUser = { preferences: {} };
    mount();

    await userEvent.click(screen.getByRole("button", { name: "xl" }));

    expect(localStorage.getItem(SCALE_STORAGE_KEY)).toBe("xl");
    await waitFor(() =>
      expect(http.body("PATCH /auth/me/preferences")).toEqual({ preferences: { [SCALE_PREF_KEY]: "xl" } }),
    );
  });

  it("does NOT call the API when nobody is signed in", async () => {
    mount();

    await userEvent.click(screen.getByRole("button", { name: "inter" }));

    await waitFor(() => expect(document.documentElement.dataset.font).toBe("inter"));
    expect(http.matching("PATCH /auth/me/preferences")).toHaveLength(0);
  });

  it("adopts the user's saved choice on a device that has none", async () => {
    currentUser = { preferences: { [FONT_PREF_KEY]: "publicSans", [SCALE_PREF_KEY]: "xs" } };

    mount();

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("publicSans/xs"));
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("publicSans");
    expect(localStorage.getItem(SCALE_STORAGE_KEY)).toBe("xs");
  });

  it("leaves this device's own choice alone, even when the server disagrees", async () => {
    localStorage.setItem(FONT_STORAGE_KEY, "geist");
    localStorage.setItem(SCALE_STORAGE_KEY, "md");
    currentUser = { preferences: { [FONT_PREF_KEY]: "publicSans", [SCALE_PREF_KEY]: "xs" } };

    mount();

    await waitFor(() => expect(document.documentElement.dataset.font).toBe("geist"));
    expect(screen.getByTestId("state")).toHaveTextContent("geist/md");
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("geist");
  });

  it("still renders when storage is unavailable — the DOM attribute is what paints", async () => {
    const setItem = Storage.prototype.setItem;
    const getItem = Storage.prototype.getItem;
    Storage.prototype.setItem = () => {
      throw new Error("private mode");
    };
    Storage.prototype.getItem = () => {
      throw new Error("private mode");
    };
    try {
      mount();
      await userEvent.click(screen.getByRole("button", { name: "inter" }));
      await waitFor(() => expect(document.documentElement.dataset.font).toBe("inter"));
    } finally {
      Storage.prototype.setItem = setItem;
      Storage.prototype.getItem = getItem;
    }
  });
});
