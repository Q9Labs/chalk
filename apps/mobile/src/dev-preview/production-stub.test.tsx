import { describe, expect, it } from "vitest";

import { DevSdkPreviewScreen } from "./production-stub";

describe("production SDK preview stub", () => {
  it("does not render the development gallery", () => {
    expect(DevSdkPreviewScreen()).toBeNull();
  });
});
