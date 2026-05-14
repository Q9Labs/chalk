import { afterEach, describe, expect, it } from "vitest";
import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";

const originalDOMException = globalThis.DOMException;

describe("ChalkError.wrap", () => {
  afterEach(() => {
    globalThis.DOMException = originalDOMException;
  });

  it("normalizes DOMException-like media errors when DOMException is unavailable", () => {
    // React Native does not expose DOMException as a global.
    globalThis.DOMException = undefined as typeof globalThis.DOMException;

    const error = ChalkError.wrap({
      name: "NotAllowedError",
      message: "Permission denied",
    });

    expect(error).toBeInstanceOf(ChalkError);
    expect(error.code).toBe(ChalkErrorCode.MEDIA_PERMISSION_DENIED);
    expect(error.message).toBe("Permission denied for media device");
  });

  it("falls back to unknown for plain non-DOMException-like objects", () => {
    globalThis.DOMException = undefined as typeof globalThis.DOMException;

    const error = ChalkError.wrap({ nope: true });

    expect(error.code).toBe(ChalkErrorCode.UNKNOWN);
    expect(error.message).toBe("[object Object]");
  });
});
