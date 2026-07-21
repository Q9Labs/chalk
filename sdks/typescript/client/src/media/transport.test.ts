import { describe, expect, it, vi } from "vitest";

import { createCloudflareSFUHTTPTransport } from "./transport";

describe("Cloudflare SFU HTTP transport failures", () => {
  it("maps the API's authoritative publication reference from add tracks", async () => {
    const publicationId = "chalk_pub_v1.eyJjIjoiY29ubmVjdGlvbi0xIiwibSI6IjAiLCJ0IjoiY2FtZXJhLXRyYWNrIiwiZyI6N30";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          sessionDescription: { type: "answer", sdp: "v=0" },
          tracks: [{ location: "local", mid: "0", trackName: "camera-track", source: "camera", publication_id: publicationId }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const transport = createCloudflareSFUHTTPTransport({ ...routeOptions(), credential: () => "media-token", fetch });

    const response = await transport.addTracks({ connectionId: "connection-1", tracks: [{ location: "local", mid: "0", trackName: "camera-track", source: "camera" }] });

    expect(response.tracks?.[0]?.publicationId).toBe(publicationId);
  });

  it("requires an explicit media credential source", () => {
    expect(() => createCloudflareSFUHTTPTransport(routeOptions())).toThrowError(expect.objectContaining({ code: "signaling_failed" }));
  });

  it("rejects an empty refreshed credential without issuing a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createCloudflareSFUHTTPTransport({ ...routeOptions(), credential: async () => " ", fetch });

    await expect(transport.listPublications()).rejects.toMatchObject({ code: "signaling_failed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps provider HTTP failures to the stable signaling error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const transport = createCloudflareSFUHTTPTransport({ ...routeOptions(), credential: () => "media-token", fetch });

    await expect(transport.renegotiate({ connectionId: "connection-1", sessionDescription: { type: "answer", sdp: "v=0" } })).rejects.toMatchObject({ code: "signaling_failed" });
  });
});

function routeOptions() {
  return { apiBaseURL: "http://localhost:8080", tenantId: "tenant", roomId: "room", sessionId: "session", participantSessionId: "participant" };
}
