/**
 * One create affordance, spelled one way, on every console.
 *
 * There were two: a plus in the panel header (Sites, Users, Tags, Templates) and
 * a dashed full-width "＋ NEW SOP" at the FOOT of the list (ingest categories,
 * the five workflow config tabs). The footer one is the worse of the two — it
 * scrolls out of reach on a long list and a keyboard user meets every row before
 * it — and having both is what makes a console feel hand-assembled.
 *
 * So this is a source scan, and it is the only thing that keeps the next screen
 * from growing its own: a rendered-output test only covers the screens someone
 * remembered to write one for.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const FILES = sourceFiles(SRC);
const rel = (f: string) => path.relative(SRC, f);

/** Strip comments — this file's own prose names the thing it forbids. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the master/detail split", () => {
  it("is 25:75 everywhere it is named", () => {
    // The rail was 300px on most screens, 280 on one and 320 on three — widths
    // nobody chose, which read as the list changing size as you move between
    // screens. ConsoleGrid's default is the split; a screen that names its own
    // must name the same one.
    const named = FILES.flatMap((f) => {
      const body = code(readFileSync(f, "utf8"));
      // Both spellings: the ConsoleGrid prop, and the hand-rolled RAIL classes
      // the screens that predate the shared grid still use. Only responsive
      // two-track grids — a table row is `grid-cols-[150px_1fr_150px_1.4fr]` and
      // has nothing to do with the master/detail split.
      return [
        ...[...body.matchAll(/cols="([^"]+)"/g)].map((m) => m[1]),
        ...[...body.matchAll(/(?:lg|xl):grid-cols-\[[^\]_]+_1fr\]/g)].map((m) => m[0]),
      ].map((v) => `${rel(f)} → ${v}`);
    });
    // A ratio layout (`[1.05fr_1fr]`) is a content split — a login page, an
    // analytics pane — not a list beside its detail. Only fixed rails are the
    // subject here, and 25% is what a fixed rail must be.
    const wrong = named.filter((n) => /grid-cols-\[(?:\d+(?:\.\d+)?(?:px|rem)|\d+%)_/.test(n) && !/\[25%_/.test(n));
    expect(wrong).toEqual([]);
  });

  it("keeps the split in the shared grid, so a screen need not repeat it", () => {
    const console_ = code(readFileSync(path.join(SRC, "components/console/index.tsx"), "utf8"));
    expect(console_).toMatch(/cols = "lg:grid-cols-\[25%_1fr\]"/);
  });
});

describe("the destructive-confirm control", () => {
  it("is the console's own dialog, never the browser's", () => {
    // `window.confirm` is unstyled browser chrome: it names the SITE, not the
    // console, carries no explanation of what the action does, and cannot be
    // told apart from a prompt raised by a page the operator is not on. Four
    // screens still raised one — the two security cards (removing SSO and the
    // directory), the workflow simulator's live run, and a report schedule —
    // while every other console used <ConfirmDialog>.
    const offenders = FILES.filter((f) => {
      const body = code(readFileSync(f, "utf8"));
      return /\bwindow\.confirm\s*\(/.test(body);
    }).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("the create control", () => {
  it("scans the real source tree", () => {
    // A glob matching nothing would make every assertion below pass.
    expect(FILES.length).toBeGreaterThan(200);
  });

  it("is nowhere spelled as a footer CTA", () => {
    const offenders = FILES.filter((f) => {
      const body = code(readFileSync(f, "utf8"));
      return /<CreateButton\b/.test(body) || /＋\s*NEW/.test(body);
    }).map(rel);
    expect(offenders).toEqual([]);
  });

  it("has no CreateButton left to import", () => {
    // Kept as a component "for the pages that still use it" is how the second
    // spelling comes back.
    const console_ = code(readFileSync(path.join(SRC, "components/console/index.tsx"), "utf8"));
    expect(console_).not.toMatch(/export function CreateButton\b/);
  });

  it("puts a plus in the header of every list that can create", () => {
    // The positive half: a screen with a create handler must carry the header
    // plus. Checked on the files that were converted plus the ones that set the
    // pattern, because a list with no create at all is not a fault.
    const withCreate = [
      "features/core/tags/Tags.tsx",
      "features/core/email-templates/EmailTemplates.tsx",
      "features/ingest/components/CategoryList.tsx",
      "features/dashforge/DashboardsManager.tsx",
      "features/workflow/components/config/SopsTab.tsx",
      "features/workflow/components/config/FormsTab.tsx",
      "features/workflow/components/config/FormatsTab.tsx",
      "features/workflow/components/config/TriggersTab.tsx",
      "features/workflow/components/config/NotificationTemplatesTab.tsx",
    ];
    const missing = withCreate.filter((f) => {
      const body = code(readFileSync(path.join(SRC, f), "utf8"));
      const at = body.indexOf("<PanelHeader");
      if (at < 0) return true;
      // The header REGION: from the tag to the next thing in the panel. A
      // non-greedy match to "/>" stops at the first nested self-closing tag
      // (PanelCounts, an IconButton) and would read a header as empty.
      const rest = body.slice(at + 1);
      const ends = [rest.indexOf("<PanelSearch"), rest.indexOf("<PanelList")].filter((i) => i >= 0);
      const header = rest.slice(0, ends.length ? Math.min(...ends) : 600);
      return !/icon="heroicons:plus"/.test(header);
    });
    expect(missing).toEqual([]);
  });
});
