/**
 * Smoke-level. The console ships ONE dark theme and no switch; this provider
 * exists so `useTheme()` call sites keep working and so a stale `theme: "light"`
 * left in localStorage by an older build can never bring the light palette back.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider, useTheme } from "./theme";

function Probe() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle}>
      {theme}
    </button>
  );
}

describe("ThemeProvider", () => {
  it("renders its children", async () => {
    render(
      <ThemeProvider>
        <p>Console</p>
      </ThemeProvider>,
    );

    expect(screen.getByText("Console")).toBeInTheDocument();
  });

  it("puts the console in dark mode and overwrites a light theme left by an older build", async () => {
    localStorage.setItem("theme", "light");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(screen.getByRole("button")).toHaveTextContent("dark");
  });

  it("survives storage being unavailable, because the class is what actually matters", async () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("private mode");
    };
    try {
      render(
        <ThemeProvider>
          <p>Console</p>
        </ThemeProvider>,
      );
      await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});
