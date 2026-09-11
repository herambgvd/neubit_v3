/**
 * THIS FILE IS A COPY, AND THIS IS THE THING THAT NOTICES WHEN IT STOPS BEING ONE.
 *
 * `pydantic.ts` exists twice — here and in `frontend/src/test/` — and the copy is
 * deliberate: the two consoles are separate npm packages with separate Docker
 * build contexts, so a cross-app import breaks `next build`. The header of both
 * files says they must be kept in step, which until now was a hope rather than a
 * control: nothing failed when they drifted, and a parser that silently disagrees
 * with its twin makes one console's contract test quietly weaker than the other's.
 *
 * A TEST can read across the repo where a build cannot — this is `fs`, not an
 * import, so nothing is bundled. The operator console's copy is the canonical one
 * and a superset (it carries `parseDictKeys`, which only it needs), so what is
 * asserted is CONTAINMENT rather than equality: everything here must still appear
 * there, unchanged.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HERE = path.join(__dirname, "pydantic.ts");
const CANONICAL = path.join(__dirname, "../../../frontend/src/test/pydantic.ts");

/** The file minus its own header comment — the two headers differ on purpose,
 *  because each explains itself to its own reader. */
function body(file: string): string {
  const src = readFileSync(file, "utf8");
  const i = src.indexOf("\nimport ");
  return (i >= 0 ? src.slice(i) : src).trim();
}

describe("the shared pydantic reader", () => {
  it("is still a copy of the operator console's", () => {
    expect(body(HERE).length).toBeGreaterThan(500); // the reader itself is not empty
    expect(body(CANONICAL)).toContain(body(HERE));
  });

  it("names the file it is a copy of, so the next reader can find the other one", () => {
    // A copy nobody knows is a copy is how two parsers end up disagreeing.
    expect(readFileSync(CANONICAL, "utf8")).toContain("admin-frontend/src/test/pydantic.ts");
  });
});
