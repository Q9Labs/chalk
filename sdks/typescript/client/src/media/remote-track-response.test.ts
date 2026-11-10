import { describe, expect, it } from "vitest";
import { matchRemotePullTracks } from "./remote-track-response";
import type { CloudflareSFUPublication, CloudflareSFUTrackRequest } from "./types";

const publications: readonly CloudflareSFUPublication[] = [{ participantId: "alice", source: "camera", publicationId: "alice-connection|camera" }];
const response: CloudflareSFUTrackRequest = { location: "remote", sessionId: "alice-connection", trackName: "camera", mid: "remote-1" };

describe("remote track response identity", () => {
  it("allows an empty partial response", () => {
    expect(matchRemotePullTracks(publications, [])).toEqual([]);
  });

  it("rejects an unrequested provider identity", () => {
    expect(() => matchRemotePullTracks(publications, [{ ...response, trackName: "another-camera" }])).toThrow("invalid remote track identity");
  });

  it("rejects duplicate provider identities", () => {
    expect(() => matchRemotePullTracks(publications, [response, { ...response, mid: "remote-2" }])).toThrow("invalid remote track identity");
  });

  it("rejects responses without a negotiated media ID", () => {
    expect(() => matchRemotePullTracks(publications, [{ ...response, mid: undefined }])).toThrow("invalid remote track identity");
  });
});
