/**
 * The on/off switch, and the rule that every one of them is named.
 *
 * It used to be a bare `<button>` with no role and no state, so assistive tech
 * announced "button" — nothing about it being a switch, and nothing about which
 * way it sat. And it renders no text of its own, so without a label a screen
 * reader gets "switch, on" with no idea what is on. Twenty-four call sites had
 * none.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Toggle } from "./kit";

describe("Toggle", () => {
  it("is a switch that reports its state, not an anonymous button", () => {
    render(<Toggle checked onChange={() => {}} label="Enable Google Maps" />);

    const el = screen.getByRole("switch", { name: "Enable Google Maps" });
    expect(el).toHaveAttribute("aria-checked", "true");
  });

  it("reports OFF as off, rather than by having nothing to report", () => {
    render(<Toggle checked={false} onChange={() => {}} label="Enable Google Maps" />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("hands back the flipped value", async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Send invite email" />);

    await userEvent.click(screen.getByRole("switch"));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does nothing when disabled", async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} disabled label="Use SSL" />);

    await userEvent.click(screen.getByRole("switch"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("takes its name from an existing element when there is one to point at", () => {
    render(
      <>
        <span id="lbl">Require two-factor</span>
        <Toggle checked onChange={() => {}} labelledBy="lbl" />
      </>,
    );
    expect(screen.getByRole("switch", { name: "Require two-factor" })).toBeInTheDocument();
  });
});

/**
 * STRUCTURAL. A switch with no accessible name is invisible to anyone not looking
 * at the screen, and the defect is silent — it renders perfectly. So the rule is
 * checked over the source rather than left to review.
 */
describe("every Toggle in the console is named", () => {
  const SRC = path.resolve(__dirname, "../..");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const uses: { file: string; snippet: string; named: boolean }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    // `[\s\S]*?` up to the first `/>`, NOT `[^>]*`. Attributes hold arrow
    // functions, so `>` appears inside almost every one of these tags — the
    // exclusive form stopped at the first `=>` and matched 4 of 24. The first
    // version of this scan silently under-counted, which is why the "found the
    // call sites at all" assertion above exists.
    for (const match of text.matchAll(/<Toggle\b[\s\S]*?\/>/g)) {
      uses.push({
        file: path.relative(SRC, file),
        snippet: match[0].replace(/\s+/g, " ").slice(0, 70),
        named: /\blabel(?:ledBy)?=/.test(match[0]),
      });
    }
  }

  it("found the call sites at all — a scan that matches nothing proves nothing", () => {
    expect(uses.length).toBeGreaterThan(15);
  });

  it("passes a label or a labelledBy at every one", () => {
    const unnamed = uses.filter((u) => !u.named).map((u) => `${u.file}  ${u.snippet}`);
    expect(unnamed, "a switch nobody can name").toEqual([]);
  });
});
