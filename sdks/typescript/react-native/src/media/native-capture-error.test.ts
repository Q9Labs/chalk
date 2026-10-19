import { describeMediaCaptureError } from "@q9labsai/chalk-client";
import { describe, expect, it } from "vitest";
import { toNativeCaptureError } from "./native-capture-error";

describe("toNativeCaptureError", () => {
  it("makes a native permission denial recoverable through the shared classifier", () => {
    const denied = toNativeCaptureError({ name: "SecurityError", message: "Permission denied." });

    expect(describeMediaCaptureError(denied).code).toBe("permission_denied");
  });

  it("leaves every other capture error as it was", () => {
    const insecure = { name: "SecurityError", message: "The operation is insecure." };
    const notFound = { name: "NotFoundError", message: "Requested device not found" };

    expect(toNativeCaptureError(insecure)).toBe(insecure);
    expect(toNativeCaptureError(notFound)).toBe(notFound);
  });
});
