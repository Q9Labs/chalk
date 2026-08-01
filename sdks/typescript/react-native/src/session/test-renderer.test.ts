import { describe, expect, it } from "vitest";

import { renderHook } from "./test-renderer";

describe("test renderer", () => {
  it("loads the workspace renderHook harness", () => {
    expect(renderHook).toBeTypeOf("function");
  });
});
