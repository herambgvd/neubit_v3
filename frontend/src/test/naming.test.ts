/**
 * File-naming convention guard.
 *
 * Walks `src/` at run time (nothing here is hard-coded to the current file list)
 * and asserts the conventions documented in `frontend/README.md`:
 *
 *   React component       PascalCase.tsx, named after the component it exports
 *   Hook                  useThing.ts
 *   Other module          camelCase.ts  (api.ts, wallLayout.ts, types.ts, ...)
 *   Next.js route file    only the framework-mandated names, only under src/app
 *   Directory             kebab-case (plus Next's `(group)` / `[param]` forms)
 *   Test                  beside its subject, same stem + `.test`
 *
 * Every assertion reports the offending path and what was expected.
 */
import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");
const APP_DIR = path.join(SRC, "app");

/** Filenames Next.js mandates. These are lowercase by decree, not by choice. */
const NEXT_ROUTE_STEMS = new Set([
  "page",
  "layout",
  "not-found",
  "error",
  "template",
  "loading",
  "global-error",
  "route",
  "default",
  "middleware",
  "sitemap",
  "robots",
  "manifest",
  "opengraph-image",
  "twitter-image",
  "icon",
  "apple-icon",
  "instrumentation",
]);

/**
 * Component files whose stem does not relate to the component they export.
 * Legacy mismatches, frozen so no *new* one can appear. Fixing one means
 * renaming its export (a behaviour-adjacent change) — do that, then delete
 * the entry. Nothing may be added here without a deliberate edit.
 */
const KNOWN_EXPORT_NAME_MISMATCHES = new Set([
  "components/LandingClient.tsx", // exports LandingPage
  "features/workflow/IncidentList.tsx", // exports WorkflowPage
  "features/workflow/IncidentDetail.tsx", // exports WorkflowDetailPage
  "features/core/sites/components/MapChrome.tsx", // exports Loading
]);

const isPascalCase = (s: string) => /^[A-Z][A-Za-z0-9]*$/.test(s) && /[a-z]/.test(s);
const isCamelCase = (s: string) => /^[a-z][A-Za-z0-9]*$/.test(s);
const isHookName = (s: string) => /^use[A-Z][A-Za-z0-9]*$/.test(s);
const isKebabCase = (s: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
/** Next route group `(app)`, dynamic `[id]`, catch-all `[...slug]`, optional `[[...slug]]`. */
const isNextDirForm = (s: string) =>
  /^\((?:[a-z0-9]+(?:-[a-z0-9]+)*)\)$/.test(s) || /^\[{1,2}\.{0,3}[A-Za-z0-9]+\]{1,2}$/.test(s);

const toPascalCase = (s: string) =>
  s
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

interface SourceFileInfo {
  /** Path relative to `src/`, POSIX separators — used in every failure message. */
  rel: string;
  abs: string;
  ext: ".ts" | ".tsx";
  /** Filename with extension and any `.test` suffix stripped. */
  stem: string;
  isTest: boolean;
  inApp: boolean;
  /** Exported *value* names (types/interfaces excluded). */
  exportedValues: string[];
  hasJsx: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function directories(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    out.push(full);
    directories(full, out);
  }
  return out;
}

/** Collect exported value names + whether the file contains JSX, via the TS AST. */
function analyse(abs: string, text: string): Pick<SourceFileInfo, "exportedValues" | "hasJsx"> {
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const exportedValues = new Set<string>();
  let hasJsx = false;

  const hasExportModifier = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const collectBindingNames = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) exportedValues.add(name.text);
    else
      for (const el of name.elements)
        if (ts.isBindingElement(el)) collectBindingNames(el.name);
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      if (hasExportModifier(stmt) && stmt.name) exportedValues.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      if (hasExportModifier(stmt))
        for (const decl of stmt.declarationList.declarations) collectBindingNames(decl.name);
    } else if (ts.isExportAssignment(stmt)) {
      // `export default <expr>` — record every identifier in the expression, so
      // `export default memo(WallTile)` still names WallTile.
      const visit = (n: ts.Node) => {
        if (ts.isIdentifier(n)) exportedValues.add(n.text);
        n.forEachChild(visit);
      };
      visit(stmt.expression);
    } else if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly || !stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
      for (const el of stmt.exportClause.elements)
        if (!el.isTypeOnly) exportedValues.add(el.name.text);
    }
  }

  const scan = (node: ts.Node) => {
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    )
      hasJsx = true;
    if (!hasJsx) node.forEachChild(scan);
  };
  scan(sf);

  return { exportedValues: [...exportedValues], hasJsx };
}

function collectSourceFiles(): SourceFileInfo[] {
  return walk(SRC)
    .filter((abs) => /\.tsx?$/.test(abs) && !abs.endsWith(".d.ts"))
    .map((abs) => {
      const ext = path.extname(abs) as ".ts" | ".tsx";
      let stem = path.basename(abs, ext);
      const isTest = stem.endsWith(".test");
      if (isTest) stem = stem.slice(0, -".test".length);
      const text = fs.readFileSync(abs, "utf8");
      return {
        rel: path.relative(SRC, abs).split(path.sep).join("/"),
        abs,
        ext,
        stem,
        isTest,
        inApp: abs.startsWith(APP_DIR + path.sep),
        ...analyse(abs, text),
      };
    });
}

const FILES = collectSourceFiles();

/** A file is a component module when it contains JSX and exports a PascalCase value. */
const componentExports = (f: SourceFileInfo) =>
  f.hasJsx ? f.exportedValues.filter(isPascalCase) : [];
const isComponentFile = (f: SourceFileInfo) => componentExports(f).length > 0;
const isRouteFile = (f: SourceFileInfo) => !f.isTest && NEXT_ROUTE_STEMS.has(f.stem);
const isBarrel = (f: SourceFileInfo) => f.stem === "index";

describe("file naming conventions", () => {
  it("finds source files to check (guards against a broken walk)", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("uses only PascalCase, camelCase or Next-mandated names — never kebab_ or snake_case", () => {
    const bad = FILES.filter(
      (f) => !isRouteFile(f) && !isBarrel(f) && !isPascalCase(f.stem) && !isCamelCase(f.stem),
    ).map(
      (f) =>
        `${f.rel}: stem "${f.stem}" is neither PascalCase nor camelCase (components -> ${toPascalCase(
          f.stem,
        )}${f.ext}, modules -> camelCase${f.ext})`,
    );
    expect(bad).toEqual([]);
  });

  it("names component files after the component (PascalCase.tsx)", () => {
    const bad = FILES.filter(
      (f) => isComponentFile(f) && !isRouteFile(f) && !isBarrel(f) && !isPascalCase(f.stem),
    )
      // Only a file that is *nothing but* one component must be named after it.
      // A module exporting several components is a component collection
      // (ui/kit.tsx) and a module exporting a component alongside other values
      // is a mixed module (lib/auth.tsx: AuthProvider + useAuth); both are named
      // for their domain, in camelCase.
      .filter((f) => componentExports(f).length === 1 && f.exportedValues.length === 1)
      .map(
        (f) =>
          `${f.rel}: component file should be PascalCase (${componentExports(f)[0]}${f.ext}), got "${f.stem}${f.ext}"`,
      );
    expect(bad).toEqual([]);
  });

  it("keeps a component file's stem tied to the component it exports", () => {
    const bad = FILES.filter(
      (f) =>
        f.ext === ".tsx" &&
        !f.isTest &&
        !isRouteFile(f) &&
        !isBarrel(f) &&
        isPascalCase(f.stem) &&
        !KNOWN_EXPORT_NAME_MISMATCHES.has(f.rel) &&
        // Collections (2+ exported components) are named for the group.
        componentExports(f).length === 1 &&
        // `Login.tsx` -> `LoginPage`, `Sites.tsx` -> `SitesConfigPage`: the stem
        // must still be recognisable in the exported component's name.
        !componentExports(f).some((n) => n === f.stem || n.includes(f.stem) || f.stem.includes(n)),
    ).map(
      (f) =>
        `${f.rel}: filename should match its component — exports ${componentExports(f).join(", ")}, expected a name containing "${f.stem}"`,
    );
    expect(bad).toEqual([]);
  });

  it("names hooks useThing.ts and exports a hook of that name", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      if (f.isTest || isRouteFile(f) || isBarrel(f)) continue;
      if (isHookName(f.stem)) {
        if (!f.exportedValues.includes(f.stem))
          bad.push(`${f.rel}: hook file must export a hook named "${f.stem}"`);
        continue;
      }
      // Conversely: a module whose only export is a hook must be named for it.
      const hooks = f.exportedValues.filter(isHookName);
      if (hooks.length === 1 && f.exportedValues.length === 1 && !isComponentFile(f))
        bad.push(`${f.rel}: hook module should be named ${hooks[0]}${f.ext}`);
    }
    expect(bad).toEqual([]);
  });

  it("names non-component modules camelCase.ts", () => {
    const bad = FILES.filter(
      (f) =>
        f.ext === ".ts" &&
        !isRouteFile(f) &&
        !isBarrel(f) &&
        // A `.ts` file holds no JSX, so a PascalCase stem here is always wrong.
        !isCamelCase(f.stem),
    ).map(
      (f) =>
        `${f.rel}: non-component module should be camelCase (${f.stem[0].toLowerCase()}${f.stem.slice(1)}${f.ext})`,
    );
    expect(bad).toEqual([]);
  });

  it("allows Next.js route filenames only under src/app", () => {
    const bad = FILES.filter((f) => isRouteFile(f) && !f.inApp).map(
      (f) => `${f.rel}: "${f.stem}${f.ext}" is a Next.js route filename and belongs under src/app/`,
    );
    expect(bad).toEqual([]);
  });

  it("allows only Next-mandated lowercase filenames inside src/app", () => {
    const bad = FILES.filter(
      (f) => f.inApp && !f.isTest && !isPascalCase(f.stem) && !isBarrel(f) && !isRouteFile(f),
    ).map(
      (f) =>
        `${f.rel}: not a Next.js route file — expected one of ${[...NEXT_ROUTE_STEMS].slice(0, 9).join(", ")}, or a PascalCase component`,
    );
    expect(bad).toEqual([]);
  });

  it("places every test beside its subject with the same stem", () => {
    const stems = new Set(
      FILES.filter((f) => !f.isTest).map((f) => `${path.dirname(f.rel)}/${f.stem}`),
    );
    const bad = FILES.filter((f) => f.isTest)
      .filter((f) => !stems.has(`${path.dirname(f.rel)}/${f.stem}`))
      // A test with no subject module (e.g. this one) still must be well-named.
      .filter((f) => !isCamelCase(f.stem) && !isPascalCase(f.stem))
      .map((f) => `${f.rel}: test file must sit beside its subject and share its stem`);
    expect(bad).toEqual([]);
  });

  it("uses kebab-case directory names", () => {
    const bad = directories(SRC)
      .map((abs) => ({ abs, name: path.basename(abs) }))
      .filter(({ name }) => !isKebabCase(name) && !isNextDirForm(name))
      .map(
        ({ abs, name }) =>
          `${path.relative(SRC, abs).split(path.sep).join("/")}: directory should be kebab-case (got "${name}")`,
      );
    expect(bad).toEqual([]);
  });
});
