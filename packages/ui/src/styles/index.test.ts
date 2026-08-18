import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./index.css", import.meta.url), "utf8");

/** Depth of the `@layer base` block at `index`; 0 means the block has closed. */
function baseLayerDepthAt(index: number): number {
  const start = stylesheet.lastIndexOf("@layer base {", index);
  if (start === -1) return 0;

  const opening = "@layer base {";
  let depth = 1;
  for (const character of stylesheet.slice(start + opening.length, index)) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return 0;
  }
  return depth;
}

describe("chalk stylesheet layering", () => {
  it("keeps the scoped reset inside the base layer, where utilities still outrank it", () => {
    const reset = stylesheet.indexOf(":where([data-chalk], .chalk-root) {");

    expect(reset).toBeGreaterThan(-1);
    expect(baseLayerDepthAt(reset)).toBeGreaterThan(0);
  });

  it("keeps the Cosmic palette independent from its chalk skin decoration", () => {
    expect(stylesheet).toContain('[data-chalk][data-chalk-palette="cosmic-chalk"] {');
    expect(stylesheet).toContain('main[data-chalk][data-chalk-skin="chalk"][data-chalk-palette="cosmic-chalk"]::before');
    expect(stylesheet).not.toContain('main[data-chalk][data-chalk-palette="cosmic-chalk"]::before');
  });
});
