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

  it("updates a reused transceiver through the Chalk tracks PUT route", async () => {
    const publicationId = "chalk_pub_v1.updated";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ tracks: [{ location: "local", mid: "0", trackName: "camera-republished", source: "camera", publication_id: publicationId }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const transport = createCloudflareSFUHTTPTransport({ ...routeOptions(), credential: () => "media-token", fetch });

    const response = await transport.updateTracks({ connectionId: "connection-1", tracks: [{ location: "local", mid: "0", trackName: "camera-republished", source: "camera" }] });

    expect(fetch.mock.calls[0]?.[0]).toBe("http://localhost:8080/v1/tenants/tenant/spaces/space/episodes/episode/participants/participant/media/sfu/tracks");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      connection_id: "connection-1",
      tracks: [{ location: "local", mid: "0", trackName: "camera-republished", source: "camera" }],
    });
    expect(response.tracks?.[0]?.publicationId).toBe(publicationId);
  });

  it("sends force close explicitly so muting does not require an SDP renegotiation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ tracks: [{ mid: "0" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const transport = createCloudflareSFUHTTPTransport({ ...routeOptions(), credential: () => "media-token", fetch });

    await transport.closeTracks({
      connectionId: "connection-1",
      tracks: [{ mid: "0", source: "camera", publicationId: "publication-1" }],
      force: true,
    });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      connection_id: "connection-1",
      tracks: [{ mid: "0", source: "camera", publication_id: "publication-1" }],
      force: true,
    });
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
  return { apiBaseURL: "http://localhost:8080", tenantId: "tenant", spaceId: "space", episodeId: "episode", participantId: "participant" };
}
