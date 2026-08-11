import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("landing technology marks", () => {
  it("keeps the SVGL marks local and available to the hero", () => {
    for (const fileName of ["typescript.svg", "react_light.svg", "cloudflare.svg"]) {
      const svg = readFileSync(new URL(`../../../public/brand/technology/${fileName}`, import.meta.url), "utf8");

      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    }
  });
});
