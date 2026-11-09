import { expect, it, vi } from "vitest";
import { createCloudflareSFUHTTPTransport } from "./transport";

function transportWith(body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  const transport = createCloudflareSFUHTTPTransport({
    apiBaseURL: "https://api.test",
    tenantId: "tenant",
    spaceId: "space",
    episodeId: "episode",
    participantId: "participant",
    bearerToken: "token",
    fetch,
  });
  return { fetch, transport };
}

it("sends one tracks request that lists the publications and pulls the audio", async () => {
  const { fetch, transport } = transportWith({
    sessionDescription: { type: "offer", sdp: "offer" },
    tracks: [{ location: "remote", sessionId: "peer", trackName: "microphone-a", mid: "0" }],
    publications: { incarnation: 2, sequence: 5, publications: [{ participant_id: "p2", source: "microphone", publication_id: "peer|microphone-a" }] },
  });

  const pulled = await transport.pullPublishedAudio?.({ connectionId: "connection" });

  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.test/v1/tenants/tenant/spaces/space/episodes/episode/participants/participant/media/sfu/tracks?allow_partial_remote_tracks=true");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ connection_id: "connection", tracks: [], pull_published_audio: true });
  expect(pulled?.snapshot).toEqual({ incarnation: 2, sequence: 5, publications: [{ participantId: "p2", source: "microphone", publicationId: "peer|microphone-a" }] });
  expect(pulled?.response.sessionDescription).toEqual({ type: "offer", sdp: "offer" });
  expect(pulled?.response.tracks).toEqual([{ location: "remote", sessionId: "peer", trackName: "microphone-a", mid: "0", publicationId: undefined }]);
});

it("rejects a pull-published response without the publication list", async () => {
  const { transport } = transportWith({});
  await expect(transport.pullPublishedAudio?.({ connectionId: "connection" })).rejects.toMatchObject({ code: "signaling_failed" });
});
