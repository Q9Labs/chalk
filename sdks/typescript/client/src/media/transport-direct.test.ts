import { afterEach, describe, expect, it, vi } from "vitest";
import { DIRECT_PATH_FAILURE_MEMORY_MS, directPathBlocked, type DirectPathMemory, type TransportPath } from "../direct-path";
import { createCloudflareSFUHTTPTransport } from "./transport";

const DIRECT = "https://direct.example.test";
const TUNNEL = "https://api.test";
const ROUTE = "/v1/tenants/t1/spaces/s1/episodes/e1/participants/p1/media/sfu/publications";
const LIST = { incarnation: 1, sequence: 1, publications: [] };

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** A transport whose fetch records every URL and answers through `handler`; the probe is the request with mode no-cors. */
function setup(handler: Handler, directBaseURL: string | null = DIRECT, memory: DirectPathMemory = new Map()) {
  const urls: string[] = [];
  const paths: TransportPath[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return handler(new URL(String(input)), init);
  });
  const transport = createCloudflareSFUHTTPTransport({
    apiBaseURL: TUNNEL,
    tenantId: "t1",
    spaceId: "s1",
    episodeId: "e1",
    participantId: "p1",
    credential: async () => "token",
    fetch: fetch as unknown as typeof globalThis.fetch,
    directMemory: memory,
    onPath: (path) => paths.push(path),
    ...(directBaseURL ? { directBaseURL } : {}),
  });
  return { transport, urls, paths, memory };
}

const onTunnel = (url: string) => new URL(url).host === new URL(TUNNEL).host;
const onDoor = (url: string) => new URL(url).host === new URL(DIRECT).host;
const CLOSE = { connectionId: "c1", sessionDescription: { type: "offer" as const, sdp: "v=0" }, tracks: [], force: false };

const answer: Handler = (url) => (url.pathname === "/" ? new Response("not found", { status: 404 }) : Response.json(LIST));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("direct signalling door", () => {
  it("keeps every call on the Tunnel when the grant advertises no door, and says so", async () => {
    const { transport, urls, paths } = setup(answer, null);

    await transport.listPublications();

    expect(urls).toEqual([`${TUNNEL}${ROUTE}`]);
    expect(paths).toEqual([{ plane: "signalling", path: "tunnel", fellBack: false }]);
  });

  it("probes the door, sends the call there and reports the direct path once", async () => {
    const { transport, urls, paths } = setup(answer);

    await transport.listPublications();
    await transport.listPublications();

    expect(urls.filter(onTunnel)).toEqual([]);
    expect(urls.filter((url) => url === `${DIRECT}/`)).toHaveLength(1);
    expect(urls.filter((url) => url === `${DIRECT}${ROUTE}`)).toHaveLength(2);
    expect(paths).toEqual([{ plane: "signalling", path: "direct", fellBack: false }]);
  });

  it("uses the Tunnel when the probe fails, remembers the failure and reports the fall back", async () => {
    const memory: DirectPathMemory = new Map();
    const { transport, urls, paths } = setup((url) => (url.origin === DIRECT ? Promise.reject(new TypeError("network error")) : Response.json(LIST)), DIRECT, memory);

    await transport.listPublications();

    expect(urls).toEqual([`${DIRECT}/`, `${TUNNEL}${ROUTE}`]);
    expect(paths).toEqual([{ plane: "signalling", path: "tunnel", fellBack: true }]);
    expect(directPathBlocked(memory, "direct.example.test", Date.now() + DIRECT_PATH_FAILURE_MEMORY_MS - 1_000)).toBe(true);
  });

  it("skips the door without a probe while the shared memory blocks it, as after a failed Sync attempt", async () => {
    const memory: DirectPathMemory = new Map([["direct.example.test", Date.now() + 60_000]]);
    const { transport, urls, paths } = setup(answer, DIRECT, memory);

    await transport.listPublications();

    expect(urls).toEqual([`${TUNNEL}${ROUTE}`]);
    expect(paths).toEqual([{ plane: "signalling", path: "tunnel", fellBack: true }]);
  });

  it.each([429, 502, 503])("replays a call on the Tunnel when the door answers %i, because the API never handled it", async (status) => {
    const { transport, urls, paths, memory } = setup((url) => (url.origin === DIRECT && url.pathname !== "/" ? new Response("refused", { status }) : answer(url, undefined)));

    await transport.listPublications();

    expect(urls).toEqual([`${DIRECT}/`, `${DIRECT}${ROUTE}`, `${TUNNEL}${ROUTE}`]);
    expect(paths).toEqual([{ plane: "signalling", path: "tunnel", fellBack: true }]);
    expect(memory.has("direct.example.test")).toBe(true);
  });

  it("sends a write exactly once when the door applies it and the connection drops before the response", async () => {
    const applied: string[] = [];
    const { transport, urls, memory } = setup((url, init) => {
      if (url.pathname === "/") return new Response("not found", { status: 404 });
      applied.push(`${url.host}${init?.method}`);
      return url.origin === DIRECT ? Promise.reject(new TypeError("network error")) : Response.json({});
    });

    await expect(transport.closeTracks(CLOSE)).rejects.toBeInstanceOf(TypeError);

    expect(applied).toEqual(["direct.example.testPUT"]);
    expect(urls.filter(onTunnel)).toEqual([]);
    expect(memory.has("direct.example.test")).toBe(true);
  });

  it("sends the next call on the Tunnel after a write failed on the door", async () => {
    const { transport, urls, paths } = setup((url) => (url.origin === DIRECT && url.pathname !== "/" ? Promise.reject(new TypeError("network error")) : answer(url, undefined)));

    await expect(transport.closeTracks(CLOSE)).rejects.toBeInstanceOf(TypeError);
    await transport.listPublications();

    expect(urls.filter(onTunnel)).toEqual([`${TUNNEL}${ROUTE}`]);
    expect(paths).toEqual([
      { plane: "signalling", path: "direct", fellBack: false },
      { plane: "signalling", path: "tunnel", fellBack: true },
    ]);
  });

  it.each([429, 502, 503])("does not replay a write the door answered %i, but moves the next call to the Tunnel", async (status) => {
    const { transport, urls, memory } = setup((url) => (url.origin === DIRECT && url.pathname !== "/" ? new Response("refused", { status }) : answer(url, undefined)));

    await expect(transport.closeTracks(CLOSE)).rejects.toMatchObject({ options: { status } });

    expect(urls.filter(onTunnel)).toEqual([]);
    expect(memory.has("direct.example.test")).toBe(true);
  });

  it("probes a recovered door again once the failure memory has expired", async () => {
    const memory: DirectPathMemory = new Map();
    let down = true;
    const { transport, urls } = setup((url) => (url.origin === DIRECT && down ? Promise.reject(new TypeError("network error")) : answer(url, undefined)), DIRECT, memory);

    await transport.listPublications();
    down = false;
    memory.clear();
    await transport.listPublications();

    expect(urls.filter(onDoor)).toEqual([`${DIRECT}/`, `${DIRECT}/`, `${DIRECT}${ROUTE}`]);
  });

  it("replays a read on the Tunnel when the connection to the door breaks after the probe", async () => {
    const { transport, urls } = setup((url) => (url.origin === DIRECT && url.pathname !== "/" ? Promise.reject(new TypeError("network error")) : answer(url, undefined)));

    await transport.listPublications();

    expect(urls.at(-1)).toBe(`${TUNNEL}${ROUTE}`);
  });

  it.each([500, 504, 401])("surfaces a %i from the door without a replay, because the API may have handled the call", async (status) => {
    const { transport, urls, memory, paths } = setup((url) => (url.origin === DIRECT && url.pathname !== "/" ? new Response("failed", { status }) : answer(url, undefined)));

    await expect(transport.listPublications()).rejects.toMatchObject({ options: { status } });

    expect(urls.filter(onTunnel)).toEqual([]);
    expect(memory.size).toBe(0);
    expect(paths).toEqual([{ plane: "signalling", path: "direct", fellBack: false }]);
  });

  it("reports the direct path when a call on the door times out", async () => {
    vi.useFakeTimers();
    const { transport, paths } = setup((url) => (url.pathname === "/" ? new Response("not found", { status: 404 }) : new Promise<Response>(() => undefined)));

    const call = expect(transport.listPublications()).rejects.toMatchObject({ code: "signaling_timeout" });
    await vi.advanceTimersByTimeAsync(9_000);
    await call;
    vi.useRealTimers();

    expect(paths).toEqual([{ plane: "signalling", path: "direct", fellBack: false }]);
  });

  it("ignores an advertised door that is not a bare https origin", async () => {
    const { transport, urls } = setup(answer, "http://direct.example.test/signal");

    await transport.listPublications();

    expect(urls).toEqual([`${TUNNEL}${ROUTE}`]);
  });
});
