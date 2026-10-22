// SCRUM-339: the pattern HUD also drives the wall tour, whose stops are pages.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PatternHud from "./PatternHud";

const hud = (over: Partial<Parameters<typeof PatternHud>[0]> = {}) =>
  render(
    <PatternHud
      patternName="Tour"
      index={1}
      total={3}
      paused={false}
      seconds={10}
      onPrev={vi.fn()}
      onNext={vi.fn()}
      onTogglePause={vi.fn()}
      onExit={vi.fn()}
      {...over}
    />,
  );

describe("the HUD's stops", () => {
  it("are groups for a pattern", () => {
    hud();
    expect(screen.getByText("Group 2 / 3 · 10s dwell")).toBeInTheDocument();
    expect(screen.getByTitle("Exit pattern")).toBeInTheDocument();
  });

  it("are pages for a tour, which it stops", () => {
    hud({ unit: "page", exitTitle: "Stop tour" });
    expect(screen.getByText("Page 2 / 3 · 10s dwell")).toBeInTheDocument();
    expect(screen.getByTitle("Next page")).toBeInTheDocument();
    expect(screen.getByTitle("Stop tour")).toBeInTheDocument();
  });
});
