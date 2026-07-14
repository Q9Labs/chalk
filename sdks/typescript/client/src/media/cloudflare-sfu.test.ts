import { describe, expect, it, vi } from "vitest";

import { CloudflareSFUError, createCloudflareSFUHTTPTransport, parseCloudflareSFUPublicationID } from "./cloudflare-sfu";

describe("Cloudflare SFU signaling", () => {
  it("maps the authenticated Chalk route without exposing provider credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ sessionDescription: { type: "answer", sdp: "provider-answer" }, tracks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const transport = createCloudflareSFUHTTPTransport({
      apiBaseURL: "http://localhost:8080/",
      bearerToken: "local-browser-token",
      tenantId: "tenant-1",
      roomId: "room-1",
      sessionId: "session-1",
      participantSessionId: "participant-1",
      fetch,
    });

    await transport.addTracks({
      connectionId: "connection-1",
      sessionDescription: { type: "offer", sdp: "browser-offer" },
      tracks: [{ location: "local", mid: "0", trackName: "camera-track", source: "camera" }],
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:8080/v1/tenants/tenant-1/rooms/room-1/sessions/session-1/participants/participant-1/media/sfu/tracks");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer local-browser-token");
    expect(init?.body).toContain('"source":"camera"');
    expect(init?.body).not.toContain("app_secret");
  });

  it("maps publication snapshots and parses the opaque pull reference", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          incarnation: 1,
          sequence: 2,
          publications: [{ participant_session_id: "participant-2", source: "camera", publication_id: "provider-session|camera-track" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost:8080", bearerToken: "token", tenantId: "t", roomId: "r", sessionId: "s", participantSessionId: "p", fetch });

    await expect(transport.listPublications()).resolves.toEqual({
      incarnation: 1,
      sequence: 2,
      publications: [{ participantSessionId: "participant-2", source: "camera", publicationId: "provider-session|camera-track" }],
    });
    expect(parseCloudflareSFUPublicationID("provider-session|camera-track")).toEqual({ sessionId: "provider-session", trackName: "camera-track" });
  });

  it("rejects ambiguous publication references", () => {
    expect(() => parseCloudflareSFUPublicationID("missing-separator")).toThrow(CloudflareSFUError);
    expect(() => parseCloudflareSFUPublicationID("a|b|c")).toThrow(CloudflareSFUError);
  });
});
