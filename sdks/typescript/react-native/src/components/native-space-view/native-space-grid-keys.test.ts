import { describe, expect, it } from "vitest";

import { nativeSpaceGridKey } from "./native-space-grid-keys";

describe("nativeSpaceGridKey", () => {
  it("changes when the ordered participant ids change and identifies an empty page", () => {
    expect(nativeSpaceGridKey("page", [{ id: "participant-a" }, { id: "participant-b" }] as never)).toBe("page-participant-a|participant-b");
    expect(nativeSpaceGridKey("page", [{ id: "participant-b" }, { id: "participant-a" }] as never)).toBe("page-participant-b|participant-a");
    expect(nativeSpaceGridKey("page", [])).toBe("page-empty");
  });
});
