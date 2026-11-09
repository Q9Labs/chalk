import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflareSFUHTTPTransport } from "./transport";
import type { CloudflareSFUHTTPTransportOptions, CloudflareSFUSignalingTransport } from "./types";

const MEDIA = "https://api.test/v1/tenants/t1/spaces/s1/episodes/e1/participants/p1/media/sfu";
const SESSION = { type: "offer", sdp: "v=0" } as const;

type Call = { readonly url: string; readonly method: string; readonly body: unknown };

function harness(unifiedSignaling: boolean | undefined, credential: CloudflareSFUHTTPTransportOptions["credential"] = async () => "token") {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return Response.json({ subscriptions: [], publications: [], incarnation: 1, sequence: 1, tracks: [] });
  });
  const transport = createCloudflareSFUHTTPTransport({
    apiBaseURL: "https://api.test",
    tenantId: "t1",
    spaceId: "s1",
    episodeId: "e1",
    participantId: "p1",
    credential,
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...(unifiedSignaling === undefined ? {} : { unifiedSignaling }),
  });
  return { transport, calls };
}

async function everyOperation(transport: CloudflareSFUSignalingTransport): Promise<void> {
  await transport.listPublications();
  await transport.listSubscriptions();
  await transport.addTracks({ connectionId: "c1", sessionDescription: SESSION, tracks: [], allowPartialRemoteTracks: true, replacementCause: "camera_switch" });
  await transport.updateTracks({ connectionId: "c1", tracks: [] });
  await transport.closeTracks({ connectionId: "c1", sessionDescription: SESSION, tracks: [{ mid: "0", source: "camera", publicationId: "pub-1" }], force: true });
  await transport.renegotiate({ connectionId: "c1", sessionDescription: SESSION });
}

afterEach(() => vi.restoreAllMocks());

describe("signaling route negotiation", () => {
  it.each([undefined, false])("keeps the per-operation routes when the API does not advertise unified signaling (%s)", async (advertised) => {
    const { transport, calls } = harness(advertised);

    await everyOperation(transport);

    expect(calls.map(({ method, url }) => `${method} ${url.replace(MEDIA, "")}`)).toEqual(["GET /publications", "GET /subscriptions", "POST /tracks?allow_partial_remote_tracks=true&replacement_cause=camera_switch", "PUT /tracks/update", "PUT /tracks/close", "POST /renegotiate"]);
  });

  it("sends every operation to the one signal route when the API advertises it", async () => {
    const { transport, calls } = harness(true);

    await everyOperation(transport);

    expect(new Set(calls.map(({ url }) => url))).toEqual(new Set([`${MEDIA}/signal`]));
    expect(calls.map(({ method }) => method)).toEqual(Array(6).fill("POST"));
    expect(calls.map(({ body }) => body)).toEqual([
      { op: "publications" },
      { op: "subscriptions" },
      { op: "tracks", connection_id: "c1", session_description: SESSION, tracks: [], allow_partial_remote_tracks: true, replacement_cause: "camera_switch" },
      { op: "tracks_update", connection_id: "c1", tracks: [] },
      { op: "tracks_close", connection_id: "c1", session_description: SESSION, close_tracks: [{ mid: "0", source: "camera", publication_id: "pub-1" }], force: true },
      { op: "renegotiate", connection_id: "c1", session_description: SESSION },
    ]);
  });
});

describe("credential read trace", () => {
  it("measures the time inside the credential provider for each signaling call, naming the operation", async () => {
    const measure = vi.spyOn(performance, "measure");
    const { transport } = harness(true, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "token";
    });

    await transport.listPublications();
    await transport.renegotiate({ connectionId: "c1", sessionDescription: SESSION });

    const entries = measure.mock.calls.filter(([name]) => name === "chalk.sfu.credential");
    expect(entries.map(([, options]) => (options as { detail: { op: string } }).detail.op)).toEqual(["publications", "renegotiate"]);
    for (const [, options] of entries) {
      const { start, end } = options as { start: number; end: number };
      expect(end - start).toBeGreaterThanOrEqual(4);
    }
  });

  it("still measures when the credential provider fails, and keeps the failure", async () => {
    const measure = vi.spyOn(performance, "measure");
    const { transport } = harness(false, async () => {
      throw new Error("no token");
    });

    await expect(transport.listPublications()).rejects.toThrow("no token");

    expect(measure.mock.calls.filter(([name]) => name === "chalk.sfu.credential")).toHaveLength(1);
  });

  it("does not let a failing observer interrupt signaling", async () => {
    vi.spyOn(performance, "measure").mockImplementation(() => {
      throw new Error("observer broke");
    });
    const { transport } = harness(true);

    await expect(transport.listPublications()).resolves.toMatchObject({ incarnation: 1 });
  });
});

function pullTransportWith(body: unknown) {
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
  const { fetch, transport } = pullTransportWith({
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
  const { transport } = pullTransportWith({});
  await expect(transport.pullPublishedAudio?.({ connectionId: "connection" })).rejects.toMatchObject({ code: "signaling_failed" });
});

it("sends the combined pull to the one signal route when the API advertised it", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ sessionDescription: { type: "offer", sdp: "offer" }, publications: { incarnation: 2, sequence: 5, publications: [] } }), { status: 200 }));
  const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "https://api.test", tenantId: "tenant", spaceId: "space", episodeId: "episode", participantId: "participant", bearerToken: "token", unifiedSignaling: true, fetch });

  const pulled = await transport.pullPublishedAudio?.({ connectionId: "connection" });

  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.test/v1/tenants/tenant/spaces/space/episodes/episode/participants/participant/media/sfu/signal");
  expect(JSON.parse(String(init.body))).toEqual({ op: "tracks", connection_id: "connection", tracks: [], pull_published_audio: true, allow_partial_remote_tracks: true });
  expect(pulled?.snapshot).toEqual({ incarnation: 2, sequence: 5, publications: [] });
});
