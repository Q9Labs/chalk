import { describe, expect, it } from "vitest";
import { assertOperationalReadiness, assertReplacementWithinCap, desiredCaptureNodes, minimumRenderNodes } from "./validate-config.mjs";

describe("recorder capacity contracts", () => {
  it("takes the maximum capture dimension and adds one ready spare", () => {
    expect(desiredCaptureNodes({ meetings: 20, participants: 100, inputMbps: 80, readySpare: 1 })).toBe(6);
    expect(desiredCaptureNodes({ meetings: 5, participants: 50, inputMbps: 20, readySpare: 0 })).toBe(2);
  });

  it("rejects capture demand above the eleven-node qualified bound", () => {
    expect(() => desiredCaptureNodes({ meetings: 20, participants: 100, inputMbps: 80, meetingsPerNode: 1, readySpare: 1 })).toThrow("above the qualified 11-node bound");
  });

  it("uses discrete job packing rather than aggregate output hours", () => {
    expect(
      minimumRenderNodes([
        { serviceMinutes: 10, deadlineMinutes: 20 },
        { serviceMinutes: 10, deadlineMinutes: 20 },
        { serviceMinutes: 10, deadlineMinutes: 20 },
      ]),
    ).toBe(2);
    expect(
      minimumRenderNodes([
        { serviceMinutes: 19, deadlineMinutes: 20 },
        { serviceMinutes: 19, deadlineMinutes: 20 },
      ]),
    ).toBe(2);
    expect(
      minimumRenderNodes([
        { serviceMinutes: 10, deadlineMinutes: 10 },
        { serviceMinutes: 10, deadlineMinutes: 10 },
      ]),
    ).toBe(2);
  });

  it("rejects replacement overlap instead of borrowing capacity above the pool cap", () => {
    expect(() => assertReplacementWithinCap({ activeNodes: 11, replacementNodes: 1, maxNodes: 11 })).toThrow("overlap the pool cap");
    expect(assertReplacementWithinCap({ activeNodes: 10, replacementNodes: 1, maxNodes: 11 })).toBe(true);
  });

  it("fails closed until staging evidence and separate provider credentials exist", () => {
    expect(() => assertOperationalReadiness({})).toThrow("recorder gate is closed");
    const ready = {
      RECORDER_STAGING_EVIDENCE_SHA256: `sha256:${"a".repeat(64)}`,
      RECORDER_STAGING_EVIDENCE_VERIFIED: "true",
      DO_CAPTURE_TOKEN: "redacted-capture-token",
      DO_RENDER_TOKEN: "redacted-render-token",
      CLOUDFLARE_API_TOKEN: "redacted-cloudflare-token",
      RECORDER_CONTROL_PLANE_ROLE_ARN: "arn:aws:iam::123456789012:role/chalk-control-plane",
    };
    expect(assertOperationalReadiness(ready)).toMatchObject({ captureTokenPresent: true, renderTokenPresent: true });
  });

  it("requires explicit production bucket adoption evidence", () => {
    const production = {
      RECORDER_ENVIRONMENT: "production",
      RECORDER_STAGING_EVIDENCE_SHA256: `sha256:${"a".repeat(64)}`,
      RECORDER_STAGING_EVIDENCE_VERIFIED: "true",
      DO_CAPTURE_TOKEN: "capture",
      DO_RENDER_TOKEN: "render",
      CLOUDFLARE_API_TOKEN: "cloudflare",
      RECORDER_CONTROL_PLANE_ROLE_ARN: "arn:aws:iam::123456789012:role/chalk-control-plane",
    };
    expect(() => assertOperationalReadiness(production)).toThrow("RECORDER_BUCKET_NAME");
    expect(
      assertOperationalReadiness({
        ...production,
        RECORDER_BUCKET_NAME: "chalk-recorder-production",
        RECORDER_BUCKET_IMPORT_ID: "private-inventory-import-id",
        RECORDER_BUCKET_ADOPTION_PLAN_SHA256: `sha256:${"b".repeat(64)}`,
      }),
    ).toMatchObject({ stagingEvidenceDigest: `sha256:${"a".repeat(64)}` });
  });
});
