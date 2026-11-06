import { describe, expect, it } from "vitest";
import { classifyMediaFailure, markMediaFailure, markMediaFetchFailure } from "./failure-diagnostics";
import { CloudflareSFUError, type CloudflareSFUSignalingTransport } from "./types";
import { createCloudflareSFUHTTPTransport } from "./transport";

describe("media failure diagnostics", () => {
  it("preserves a marked fetch failure that has its own transport cause", async () => {
    const error = new TypeError("private fetch URL", { cause: new Error("private host and port") });
    const transport = createCloudflareSFUHTTPTransport({
      apiBaseURL: "https://private.test",
      bearerToken: "private",
      tenantId: "t",
      spaceId: "s",
      episodeId: "e",
      participantId: "p",
      fetch: async () => {
        throw error;
      },
    });
    await expect(transport.listPublications()).rejects.toBe(error);
    expect(classifyMediaFailure(new Error("wrapper", { cause: error }), "peer_connection")).toEqual({ media_error_kind: "network", media_error_step: "sfu_publications" });
  });
  it.each(["tracks", "close_tracks", "renegotiate", "publications", "subscriptions"] as const)("preserves error identity and identifies the SFU %s call", async (operation) => {
    const error = new TypeError("private URL and token");
    const transport = createCloudflareSFUHTTPTransport({
      apiBaseURL: "https://private.test",
      bearerToken: "private",
      tenantId: "t",
      spaceId: "s",
      episodeId: "e",
      participantId: "p",
      fetch: async () => {
        throw error;
      },
    });
    const pending =
      operation === "tracks"
        ? transport.addTracks({ connectionId: "private", tracks: [] })
        : operation === "close_tracks"
          ? transport.closeTracks({ connectionId: "private", tracks: [], force: true })
          : operation === "renegotiate"
            ? transport.renegotiate({ connectionId: "private", sessionDescription: { type: "answer", sdp: "private" } })
            : operation === "subscriptions"
              ? listSubscriptions(transport)
              : transport.listPublications();
    await expect(pending).rejects.toBe(error);
    expect(classifyMediaFailure(error, "peer_connection")).toEqual({ media_error_kind: "network", media_error_step: `sfu_${operation}` });
  });
  it("reads subscription state from the participant's media route and maps it to the SDK's names", async () => {
    const requests: string[] = [];
    const transport = createCloudflareSFUHTTPTransport({
      apiBaseURL: "https://api.test/",
      bearerToken: "token",
      tenantId: "t",
      spaceId: "s",
      episodeId: "e",
      participantId: "p",
      fetch: async (url) => {
        requests.push(String(url));
        return Response.json({ subscriptions: [{ mid: "2", session_id: "publisher", track_name: "camera", state: "paused", reason: "congestion", revision: 4, requested_rid: "h" }] });
      },
    });
    await expect(listSubscriptions(transport)).resolves.toEqual([{ mid: "2", sessionId: "publisher", trackName: "camera", state: "paused", reason: "congestion", revision: 4, requestedRid: "h" }]);
    expect(requests).toEqual(["https://api.test/v1/tenants/t/spaces/s/episodes/e/participants/p/media/sfu/subscriptions"]);
  });
  it.each(["NotAllowedError", "NotReadableError", "NotFoundError", "OverconstrainedError", "AbortError", "SecurityError", "InvalidStateError", "OperationError", "NotSupportedError"])("allowlists %s without its private message", (name) => {
    expect(classifyMediaFailure(new DOMException("private device label", name), "local_capture")).toEqual({ media_error_kind: name, media_error_step: "local_capture" });
  });
  it("unwraps bounded causes and retains the SFU operation and HTTP status", () => {
    const error = new CloudflareSFUError("private URL and token", "signaling_failed", { status: 503, providerCode: "private" });
    markMediaFailure(error, "sfu_tracks");
    expect(classifyMediaFailure(new Error("wrapper", { cause: error }), "peer_connection")).toEqual({ media_error_kind: "CloudflareSFUError", media_error_step: "sfu_tracks", http_status: 503 });
  });
  it("distinguishes fetch failures from unrelated TypeErrors and deadlines", () => {
    const error = new TypeError("private URL");
    expect(classifyMediaFailure(error, "peer_connection").media_error_kind).toBe("unknown");
    markMediaFetchFailure(error);
    markMediaFailure(error, "sfu_publications");
    expect(classifyMediaFailure(error, "peer_connection")).toEqual({ media_error_kind: "network", media_error_step: "sfu_publications" });
    expect(classifyMediaFailure(new CloudflareSFUError("private", "signaling_timeout"), "sfu_tracks").media_error_kind).toBe("timeout");
    expect(classifyMediaFailure(new DOMException("private", "TimeoutError"), "peer_connection").media_error_kind).toBe("timeout");
    expect(classifyMediaFailure(new DOMException("private", "NetworkError"), "peer_connection").media_error_kind).toBe("network");
  });
  it("bounds unknown, cyclic, forged and invalid-status errors", () => {
    const cyclic: { cause?: unknown; name: string } = { name: "NotAllowedError" };
    cyclic.cause = cyclic;
    for (const error of [cyclic, "private", null, new DOMException("private", "private"), { name: "NotAllowedError", message: "private" }]) {
      expect(classifyMediaFailure(error, "local_capture")).toEqual({ media_error_kind: "unknown", media_error_step: "local_capture" });
    }
    expect(classifyMediaFailure(new CloudflareSFUError("private", "signaling_failed", { status: 999 }), "sfu_tracks")).not.toHaveProperty("http_status");
  });
});

function listSubscriptions(transport: CloudflareSFUSignalingTransport) {
  if (!transport.listSubscriptions) throw new Error("the HTTP transport reads subscription state");
  return transport.listSubscriptions();
}
