import { afterEach, expect, it, vi } from "vitest";
import { declaredIcons, favicon, publicHostname, registrableParent, sniffImage, type FaviconDeps, type IconCache, type IconFetcher } from "./favicon";

afterEach(() => vi.restoreAllMocks());

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });
const missing = () => new Response(null, { status: 404 });

/** A fake internet: the answer for each URL, and a record of every URL Chalk asked for. */
function internet(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetcher: IconFetcher = async (url) => {
    asked.push(url.href);
    return (routes[url.href] ?? missing)();
  };
  return { asked, fetcher };
}
const deps = (fetcher: IconFetcher, cache: IconCache | null = null): FaviconDeps => ({ fetcher, cache });
const png = () => new Response(PNG, { headers: { "Content-Type": "image/png" } });

it.each([
  "127.0.0.1",
  "10.0.0.5",
  "192.168.1.1",
  "169.254.169.254",
  "2130706433",
  "0x7f.1",
  "127.1",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "localhost",
  "app.localhost",
  "printer.local",
  "db.internal",
  "intranet",
  "example.com:8443",
  "example.com/path",
  "user@example.com",
  "example.com?x=1",
  "a..com",
  "example.123",
])("refuses %s as an icon host", (host) => {
  expect(publicHostname(host)).toBeNull();
});

it("accepts a public DNS name and normalises it", () => {
  expect(publicHostname("Portal.TuitionHighway.com")).toBe("portal.tuitionhighway.com");
  expect(publicHostname("example.com.")).toBe("example.com");
  expect(publicHostname("bücher.de")).toBe("xn--bcher-kva.de");
});

it("finds the registrable parent of a host", () => {
  expect(registrableParent("app.portal.example.com")).toBe("example.com");
  expect(registrableParent("shop.example.co.uk")).toBe("example.co.uk");
  expect(registrableParent("example.com")).toBeNull();
  expect(registrableParent("example.co.uk")).toBeNull();
});

it("recognises images by their bytes and refuses SVG and HTML", () => {
  expect(sniffImage(PNG)).toBe("image/png");
  expect(sniffImage(new Uint8Array([0, 0, 1, 0, 1, 0]))).toBe("image/x-icon");
  expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
  expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(sniffImage(SVG)).toBeNull();
  expect(sniffImage(new TextEncoder().encode("<!doctype html>"))).toBeNull();
});

it("reads the icons a page declares, in order, and skips other links", () => {
  const page = `<head><link rel="stylesheet" href="/a.css"><link rel='shortcut icon' href='/fav.ico'><link href="/touch.png" rel="apple-touch-icon"><link rel="mask-icon" href="/mask.svg"></head>`;
  expect(declaredIcons(page)).toEqual(["/fav.ico", "/touch.png"]);
});

it("serves /favicon.ico from Chalk with headers that stop it running as a page", async () => {
  const site = internet({ "https://example.com/favicon.ico": png });
  const response = await favicon("example.com", deps(site.fetcher));
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  expect(response.headers.get("Cache-Control")).toMatch(/^private, max-age=\d+$/);
});

it("labels the response by what the bytes are, not by what the site claimed", async () => {
  const site = internet({ "https://example.com/favicon.ico": () => new Response(PNG, { headers: { "Content-Type": "text/html" } }) });
  expect((await favicon("example.com", deps(site.fetcher))).headers.get("Content-Type")).toBe("image/png");
});

it("falls back to the icon the page declares", async () => {
  const site = internet({ "https://example.com/": () => html('<link rel="icon" href="/static/brand.png">'), "https://example.com/static/brand.png": png });
  const response = await favicon("example.com", deps(site.fetcher));
  expect(response.status).toBe(200);
  expect(site.asked).toEqual(["https://example.com/favicon.ico", "https://example.com/", "https://example.com/static/brand.png"]);
});

it("falls back to the registrable parent when the host has no icon", async () => {
  const site = internet({ "https://example.com/favicon.ico": png });
  expect((await favicon("app.portal.example.com", deps(site.fetcher))).status).toBe(200);
});

it("answers 204 (no icon) when the answer is not an image", async () => {
  const site = internet({ "https://example.com/favicon.ico": () => new Response(SVG, { headers: { "Content-Type": "image/svg+xml" } }), "https://example.com/": () => html("<p>no icon</p>") });
  expect((await favicon("example.com", deps(site.fetcher))).status).toBe(204);
});

it("rejects a private or malformed host with 400 before any request", async () => {
  const site = internet({});
  await expect(favicon("127.0.0.1", deps(site.fetcher))).rejects.toMatchObject({ status: 400, code: "invalid_host" });
  await expect(favicon("localhost", deps(site.fetcher))).rejects.toMatchObject({ status: 400 });
  expect(site.asked).toEqual([]);
});

it.each(["https://127.0.0.1/favicon.ico", "https://169.254.169.254/latest/meta-data/", "https://localhost/x", "https://db.internal/x", "http://example.org/favicon.ico", "https://example.org:8443/favicon.ico"])("does not follow a redirect to %s", async (target) => {
  const site = internet({ "https://example.com/favicon.ico": () => redirect(target), "https://example.com/": missing });
  const response = await favicon("example.com", deps(site.fetcher));
  expect(response.status).toBe(204);
  expect(site.asked).not.toContain(target);
});

it("follows a redirect to another public host and checks that hop too", async () => {
  const site = internet({ "https://example.com/favicon.ico": () => redirect("https://cdn.example.net/i.png"), "https://cdn.example.net/i.png": png });
  expect((await favicon("example.com", deps(site.fetcher))).status).toBe(200);
});

it("stops after three redirects", async () => {
  const site = internet({
    "https://example.com/favicon.ico": () => redirect("https://a.example.net/1"),
    "https://a.example.net/1": () => redirect("https://a.example.net/2"),
    "https://a.example.net/2": () => redirect("https://a.example.net/3"),
    "https://a.example.net/3": () => redirect("https://a.example.net/4"),
    "https://a.example.net/4": png,
    "https://example.com/": missing,
  });
  expect((await favicon("example.com", deps(site.fetcher))).status).toBe(204);
  expect(site.asked).not.toContain("https://a.example.net/4");
});

it("does not use a declared icon that points at a private address", async () => {
  const site = internet({ "https://example.com/": () => html('<link rel="icon" href="https://10.0.0.1/i.png"><link rel="icon" href="//localhost/i.png">') });
  expect((await favicon("example.com", deps(site.fetcher))).status).toBe(204);
  expect(site.asked.some((url) => url.includes("10.0.0.1") || url.includes("localhost"))).toBe(false);
});

it("refuses an icon whose declared length is over the cap", async () => {
  const site = internet({ "https://example.com/favicon.ico": () => new Response(PNG, { headers: { "Content-Length": String(10 * 1024 * 1024) } }), "https://example.com/": () => html("<p>none</p>") });
  expect((await favicon("example.com", deps(site.fetcher))).status).toBe(204);
});

it("stops reading a body that grows past the cap, even when it never declares a length", async () => {
  let cancelled = false;
  let sent = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 64 * 1024;
      controller.enqueue(new Uint8Array(64 * 1024).fill(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const site = internet({ "https://example.com/favicon.ico": () => new Response(endless), "https://example.com/": missing });
  expect((await favicon("example.com", deps(site.fetcher))).status).toBe(204);
  expect(cancelled).toBe(true);
  expect(sent).toBeLessThan(1024 * 1024);
});

it("gives every request a deadline and treats a timeout as no icon", async () => {
  const real = AbortSignal.timeout.bind(AbortSignal);
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(10));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const hangs: IconFetcher = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  expect((await favicon("example.com", deps(hangs))).status).toBe(204);
  expect(timeout).toHaveBeenCalledWith(3000);
});

function memoryCache(): IconCache {
  const store = new Map<string, Response>();
  return {
    async match(request) {
      return store.get(request.url)?.clone();
    },
    async put(request, response) {
      store.set(request.url, response);
    },
  };
}

it("asks the site once and answers repeat requests, hits and misses alike, from the cache", async () => {
  const cache = memoryCache();
  const found = internet({ "https://example.com/favicon.ico": png });
  expect((await favicon("example.com", deps(found.fetcher, cache))).status).toBe(200);
  expect((await favicon("example.com", deps(found.fetcher, cache))).status).toBe(200);
  expect(found.asked).toHaveLength(1);

  const none = internet({});
  expect((await favicon("nothing.example.org", deps(none.fetcher, cache))).status).toBe(204);
  const askedOnce = none.asked.length;
  expect((await favicon("nothing.example.org", deps(none.fetcher, cache))).status).toBe(204);
  expect(none.asked).toHaveLength(askedOnce);
});
