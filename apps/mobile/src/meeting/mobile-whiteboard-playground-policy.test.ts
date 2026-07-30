import { describe, expect, it } from "vitest";
import { shouldShowWhiteboardRendererPlayground } from "./mobile-whiteboard-playground-policy";

describe("whiteboard renderer playground policy", () => {
  it("is visible only on the development home screen", () => {
    expect(shouldShowWhiteboardRendererPlayground({ isDevRuntime: true, routeKind: "home" })).toBe(true);
    expect(shouldShowWhiteboardRendererPlayground({ isDevRuntime: false, routeKind: "home" })).toBe(false);
    expect(shouldShowWhiteboardRendererPlayground({ isDevRuntime: true, routeKind: "lobby" })).toBe(false);
  });
});
