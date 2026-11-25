import { describe, expect, it } from "vitest";
import { lifecycleFailure } from "../connection/lifecycle-failure";
import { SFUError } from "../media";
import { failureFromError, normalizeClientError } from "./errors";
import { getConnectionFailureDetail } from "./failure-detail";

const NETWORK_DETAIL = "Audio and video could not connect. Your network may block calls. Try again, or switch networks.";

function mediaStartFailure(cause: unknown) {
  return failureFromError(normalizeClientError(lifecycleFailure("media_start_failed", true, "The media layer could not start", cause)));
}

describe("a media start failure's message", () => {
  it("says the problem is on our side when Chalk's media signalling refused the request", () => {
    const failure = mediaStartFailure(new SFUError("Chalk SFU signaling failed with HTTP 400", "signaling_failed", { status: 400, retryableConnection: false }));
    expect(failure.code).toBe("connection.media_start_failed");
    expect(failure.mediaHttpStatus).toBe(400);
    const detail = getConnectionFailureDetail(failure);
    expect(detail).toContain("Something on our side failed");
    expect(detail).not.toMatch(/network/i);
  });

  it("still blames the network when nothing answered", () => {
    const failure = mediaStartFailure(new TypeError("Failed to fetch"));
    expect(failure.mediaHttpStatus).toBeUndefined();
    expect(getConnectionFailureDetail(failure)).toBe(NETWORK_DETAIL);
  });

  it("still blames the network when the answer was a server outage", () => {
    const failure = mediaStartFailure(new SFUError("Chalk SFU signaling failed with HTTP 503", "signaling_failed", { status: 503, retryableConnection: true }));
    expect(failure.mediaHttpStatus).toBeUndefined();
    expect(getConnectionFailureDetail(failure)).toBe(NETWORK_DETAIL);
  });

  it("tells the person their network or VPN blocked an ICE connection", () => {
    const failure = mediaStartFailure(new SFUError("Timed out waiting for the Chalk SFU peer connection", "ice_connection_failed"));
    expect(failure.mediaIceFailure).toBe(true);
    expect(getConnectionFailureDetail(failure)).toBe("Your network or VPN is blocking the call connection. Turn off the VPN or try another network, then join again.");
  });

  it("does not treat a rejected media grant as a fault of ours", () => {
    const failure = mediaStartFailure(new SFUError("Chalk SFU signaling failed with HTTP 403", "signaling_failed", { status: 403, retryableConnection: false }));
    expect(failure.mediaHttpStatus).toBeUndefined();
  });
});
