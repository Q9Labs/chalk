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

const answer: Handler = (url) => (url.pathname === "/" ? new Response("not found", { status: 404 }) : Response.json(LIST));

afterEach(() => vi.restoreAllMocks());

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

    expect(urls.filter((url) => url.startsWith(TUNNEL))).toEqual([]);
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

  it("replays a call on the Tunnel when the connection to the door breaks after the probe", async () => {
    const { transport, urls } = setup((url) => (url.origin === DIRECT && url.pathname !== "/" ? Promise.reject(new TypeError("network error")) : answer(url, undefined)));

    await transport.listPublications();

    expect(urls.at(-1)).toBe(`${TUNNEL}${ROUTE}`);
  });

  it.each([500, 504, 401])("surfaces a %i from the door without a replay, because the API may have handled the call", async (status) => {
    const { transport, urls, memory } = setup((url) => (url.origin === DIRECT && url.pathname !== "/" ? new Response("failed", { status }) : answer(url, undefined)));

    await expect(transport.listPublications()).rejects.toMatchObject({ options: { status } });

    expect(urls.filter((url) => url.startsWith(TUNNEL))).toEqual([]);
    expect(memory.size).toBe(0);
  });

  it("ignores an advertised door that is not a bare https origin", async () => {
    const { transport, urls } = setup(answer, "http://direct.example.test/signal");

    await transport.listPublications();

    expect(urls).toEqual([`${TUNNEL}${ROUTE}`]);
  });
});
