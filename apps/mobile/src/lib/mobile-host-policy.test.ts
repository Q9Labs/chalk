import { describe, expect, it } from "vitest";
import { isMobileHostCreationEnabled } from "./mobile-host-policy";

describe("mobile host policy", () => {
  it("allows configured or local-bootstrap meeting creation in development", () => {
    expect(isMobileHostCreationEnabled({ isDevRuntime: true, hasConfiguredHostKey: true, canBootstrapLocalHost: false })).toBe(true);
    expect(isMobileHostCreationEnabled({ isDevRuntime: true, hasConfiguredHostKey: false, canBootstrapLocalHost: true })).toBe(true);
  });

  it("fails closed in release builds until a production mobile broker exists", () => {
    expect(isMobileHostCreationEnabled({ isDevRuntime: false, hasConfiguredHostKey: true, canBootstrapLocalHost: true })).toBe(false);
    expect(isMobileHostCreationEnabled({ isDevRuntime: false, hasConfiguredHostKey: false, canBootstrapLocalHost: false })).toBe(false);
  });
});
