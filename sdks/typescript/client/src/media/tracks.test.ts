import { describe, expect, it } from "vitest";

import { comparePublicationCursor, parseCloudflareSFUPublicationID, requireDescription, validatePublicationSnapshot } from "./tracks";

describe("Cloudflare SFU track contracts", () => {
  it("decodes the real versioned Chalk publication reference for remote pulls", () => {
    const publicationId = "chalk_pub_v1.eyJjIjoiY29ubmVjdGlvbi0xIiwibSI6IjAiLCJ0IjoiY2FtZXJhLXRyYWNrIiwiZyI6N30";

    expect(parseCloudflareSFUPublicationID(publicationId)).toEqual({ sessionId: "connection-1", trackName: "camera-track" });
  });

  it("retains explicit legacy pull compatibility and rejects unknown Chalk versions", () => {
    expect(parseCloudflareSFUPublicationID("provider-session|camera-track")).toEqual({ sessionId: "provider-session", trackName: "camera-track" });
    expect(() => parseCloudflareSFUPublicationID("chalk_pub_v2.payload")).toThrowError(expect.objectContaining({ code: "invalid_publication" }));
  });

  it.each([
    { c: "connection-1", m: "0", t: "camera-track", g: 0 },
    { c: " connection-1", m: "0", t: "camera-track", g: 1 },
    { c: "connection-1", m: "0", t: "camera-track", g: 1, extra: true },
    { c: "connection-1", t: "camera-track", g: 1 },
  ])("rejects malformed versioned publication payloads", (payload) => {
    expect(() => parseCloudflareSFUPublicationID(versionedReference(payload))).toThrowError(expect.objectContaining({ code: "invalid_publication" }));
  });

  it("validates publication identity and detects conflicting equal cursors", () => {
    const snapshot = { incarnation: 2, sequence: 4, publications: [{ participantSessionId: "participant-2", source: "camera" as const, publicationId: "provider-session|camera-track" }] };
    const cursor = validatePublicationSnapshot(snapshot);

    expect(parseCloudflareSFUPublicationID(snapshot.publications[0]!.publicationId)).toEqual({ sessionId: "provider-session", trackName: "camera-track" });
    expect(comparePublicationCursor(null, cursor)).toBe("newer");
    expect(() => comparePublicationCursor(cursor, { ...cursor, signature: "conflict" })).toThrowError(expect.objectContaining({ code: "invalid_publication" }));
  });

  it("requires complete browser SDP", () => {
    expect(requireDescription({ type: "offer", sdp: "v=0" })).toEqual({ type: "offer", sdp: "v=0" });
    expect(() => requireDescription({ type: "offer" })).toThrowError(expect.objectContaining({ code: "media_failed" }));
  });
});

function versionedReference(payload: object): string {
  return `chalk_pub_v1.${globalThis.btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}
