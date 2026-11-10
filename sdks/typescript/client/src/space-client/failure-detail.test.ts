import { expect, it } from "vitest";
import { getRecordingFailureDetail } from "./failure-detail";

it("explains an unsupported provider and falls back for any other Recording failure", () => {
  expect(getRecordingFailureDetail("recording_capture_unsupported")).toBe("Recording isn’t available in this call yet.");
  expect(getRecordingFailureDetail("provider_rejected")).toBe("Recording failed. Try again.");
  expect(getRecordingFailureDetail(null)).toBe("Recording failed. Try again.");
});
