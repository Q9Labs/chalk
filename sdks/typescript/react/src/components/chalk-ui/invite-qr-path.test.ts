import { encode } from "uqr";
import { expect, it } from "vitest";
import { roundedQrPaths } from "./invite-qr-path";

const grid = (rows: readonly string[]) => rows.map((row) => [...row].map((cell) => cell === "#"));
const FINDER_FREE = 21;

it("rounds every corner of a lone module", () => {
  const { modules } = roundedQrPaths(grid(Array.from({ length: FINDER_FREE }, (_, y) => (y === 10 ? ".".repeat(10) + "#" + ".".repeat(10) : ".".repeat(FINDER_FREE)))));
  expect(modules.match(/a0\.5 0\.5/g)).toHaveLength(4);
});

it("keeps the touching sides of neighbouring modules square so they join", () => {
  const row = ".".repeat(10) + "##" + ".".repeat(9);
  const { modules } = roundedQrPaths(grid(Array.from({ length: FINDER_FREE }, (_, y) => (y === 10 ? row : ".".repeat(FINDER_FREE)))));
  expect(modules.match(/a0\.5 0\.5/g)).toHaveLength(4);
  expect(modules.startsWith("M10.5 10H11V11H10.5a0.5 0.5")).toBe(true);
});

it("draws the three finder patterns as rings and leaves their cells out of the module grid", () => {
  const { data, size } = encode("https://chalkmeet.com/many-match-wagon-7f3k", { ecc: "M", border: 0 });
  const { modules, finders } = roundedQrPaths(data);
  expect(finders.match(/zM/g)).toHaveLength(8);
  expect(finders).toContain(`M1.6 0`);
  expect(finders).toContain(`M${size - 7 + 1.6} 0`);
  expect(finders).toContain(`M1.6 ${size - 7}`);
  expect(modules).not.toMatch(/^M[0-6] [0-6][H]/);
});
