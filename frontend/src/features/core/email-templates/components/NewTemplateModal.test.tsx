/**
 * A template's name is its identity on the wire — the backend looks the template
 * up by it — so the modal must refuse three different bad names for three
 * different reasons, in the order a person would check them: is there a name at
 * all, is it a legal one, is it already taken. Reordering these makes the modal
 * complain about the shape of an empty string.
 */
import { describe, expect, it } from "vitest";

import { nameError } from "./NewTemplateModal";

describe("nameError", () => {
  it("accepts a legal, unused name", () => {
    expect(nameError("welcome_email", ["password_reset"])).toBe("");
  });

  it("asks for a name before it judges the shape of one", () => {
    expect(nameError("", [])).toBe("A name is required.");
  });

  it("rejects names the backend cannot address", () => {
    for (const bad of ["Welcome", "9lives", "has space", "kebab-case", "a"]) {
      expect(nameError(bad, [])).toContain("Lower-case letters");
    }
  });

  it("rejects a name that already exists", () => {
    expect(nameError("welcome_email", ["welcome_email"])).toBe("A template with that name already exists.");
  });
});
