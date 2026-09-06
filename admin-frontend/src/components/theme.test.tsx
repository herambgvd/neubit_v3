import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider, useTheme } from "./theme";

function Probe() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle}>
      {theme}
    </button>
  );
}

const renderTheme = () =>
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  );

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("theme", () => {
  it("defaults to dark when nothing is stored", async () => {
    renderTheme();

    expect(await screen.findByRole("button", { name: "dark" })).toBeInTheDocument();
  });

  it("restores a saved light choice after mount", async () => {
    localStorage.setItem("theme", "light");

    renderTheme();

    expect(await screen.findByRole("button", { name: "light" })).toBeInTheDocument();
  });

  it("treats an unrecognised stored value as dark rather than crashing", async () => {
    localStorage.setItem("theme", "solarized");

    renderTheme();

    expect(await screen.findByRole("button", { name: "dark" })).toBeInTheDocument();
  });

  it("toggling writes the class on <html> and persists the choice", async () => {
    renderTheme();
    await userEvent.click(await screen.findByRole("button", { name: "dark" }));

    expect(screen.getByRole("button", { name: "light" })).toBeInTheDocument();
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBe("light");

    await userEvent.click(screen.getByRole("button", { name: "light" }));

    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
  });
});
