import { describe, expect, it, vi } from "vitest";

vi.mock("expo-constants", () => ({ default: { nativeAppVersion: "2.0.0", nativeBuildVersion: "28", expoConfig: { version: "1.0.0" } } }));

import { getMobileFeedbackEvidence } from "./mobile-feedback";

describe("mobile Feedback evidence", () => {
  it("exposes only bounded app release metadata", () => {
    expect(getMobileFeedbackEvidence()).toEqual({ app: { name: "Chalk", version: "2.0.0", build: "28" } });
    expect(JSON.stringify(getMobileFeedbackEvidence())).not.toContain("scriptURL");
  });
});
