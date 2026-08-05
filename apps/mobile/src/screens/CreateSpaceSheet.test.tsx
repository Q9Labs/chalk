import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./CreateSpaceSheet.tsx", import.meta.url), "utf8");

describe("CreateSpaceSheet", () => {
  it("uses a native slide-up modal with dismiss and creation controls", () => {
    expect(source).toContain('<Modal animationType="slide"');
    expect(source).toContain('accessibilityLabel="Close Create Space"');
    expect(source).toContain("accessibilityViewIsModal");
    expect(source).toContain("onSubmitEditing={onCreate}");
    expect(source).toContain("disabled={isCreating}");
    expect(source).toContain("does not create or save a new Space");
  });
});
