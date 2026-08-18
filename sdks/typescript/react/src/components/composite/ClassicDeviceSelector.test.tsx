import { describe, expect, it } from "vitest";

import { ClassicDeviceSelector } from "./ClassicDeviceSelector";

describe("ClassicDeviceSelector", () => {
  it("exports the classic renderer", () => {
    expect(ClassicDeviceSelector).toBeDefined();
  });
});
