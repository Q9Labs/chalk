import { describe, expect, it } from "vitest";
import * as extractedAssets from "@q9labsai/chalk-assets";
import * as compatibilityAssets from "./assets";

describe("chalk-ui assets compatibility export", () => {
  it("re-exports every chalk-assets export", () => {
    expect(compatibilityAssets).toEqual(extractedAssets);
  });
});
