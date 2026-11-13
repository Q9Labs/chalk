import { DashboardError } from "./http";

// The icon a website or webhook endpoint shows in the Developer page. The visitor's browser asks Chalk, Chalk fetches the icon from the site, so the site never sees the visitor.
// Everything the site controls is bounded: where we connect (public https hosts only), how many redirects we follow, how long we wait, how many bytes we read, and what the bytes must be.

const ICON_LIMIT = 128 * 1024;
const PAGE_LIMIT = 128 * 1024;
const TIMEOUT_MS = 3000;
const MAX_REDIRECTS = 3;
const PAGE_ICONS_TRIED = 3;
const FOUND_SECONDS = 24 * 60 * 60;
const MISSING_SECONDS = 60 * 60;

const INTERNAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".lan", ".home.arpa", ".intranet", ".corp", ".home"];
const SECOND_LEVEL_LABELS = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "or", "ne", "go"]);

type Bytes = Uint8Array<ArrayBuffer>;

export type IconFetcher = (url: URL, init: RequestInit) => Promise<Response>;
export interface IconCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
export interface FaviconDeps {
  readonly fetcher: IconFetcher;
  readonly cache: IconCache | null;
}

/** The host as the network will see it, or null when it is not a public DNS name: IP addresses, single-label names, `localhost`, private suffixes, ports, paths. */
function bareHostUrl(input: string): URL | null {
  try {
    const url = new URL(`https://${input}`);
    const bare = !(url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash);
    return bare ? url : null;
  } catch {
    return null;
  }
}

function publicLabels(host: string): boolean {
  if (host.length > 253 || host.startsWith("[") || !host.includes(".")) return false;
  const labels = host.split(".");
  const tld = labels[labels.length - 1] ?? "";
  return !labels.includes("") && /^[a-z][a-z0-9-]*$/.test(tld);
}

export function publicHostname(input: string): string | null {
  const url = bareHostUrl(input);
  if (!url) return null;
  const host = url.hostname.replace(/\.$/, "");
  if (!publicLabels(host)) return null;
  if (host === "localhost" || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
  return host;
}

/** `example.com` for `app.portal.example.com`. A short list of second-level labels covers `.co.uk` style names; this is a heuristic, not the public suffix list. */
export function registrableParent(host: string): string | null {
  const labels = host.split(".");
  const tld = labels[labels.length - 1] ?? "";
  const second = labels[labels.length - 2] ?? "";
  const keep = tld.length === 2 && SECOND_LEVEL_LABELS.has(second) ? 3 : 2;
  return labels.length > keep ? labels.slice(-keep).join(".") : null;
}

export type IconType = "image/png" | "image/x-icon" | "image/gif" | "image/jpeg" | "image/webp";

/** What the bytes are, judged by the bytes. SVG is refused on purpose: it can carry script. */
export function sniffImage(bytes: Uint8Array): IconType | null {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/** The `href` of each icon a page declares, in document order. */
export function declaredIcons(html: string): string[] {
  const hrefs: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) attributes.set((match[1] ?? "").toLowerCase(), match[2] ?? match[3] ?? "");
    const relation = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attributes.get("href");
    if (href && relation.some((word) => word === "icon" || word === "apple-touch-icon")) hrefs.push(href);
  }
  return hrefs;
}

async function readCapped(body: ReadableStream<Uint8Array>, limit: number): Promise<Bytes | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function checked(url: URL): boolean {
  return url.protocol === "https:" && publicHostname(url.host) !== null;
}

type Hop = { readonly kind: "stop" } | { readonly kind: "redirect"; readonly url: URL } | { readonly kind: "body"; readonly bytes: Bytes };
const STOP: Hop = { kind: "stop" };

/** One request: a redirect to follow, the capped body, or a stop. */
async function hop(fetcher: IconFetcher, url: URL, limit: number): Promise<Hop> {
  if (!checked(url)) return STOP;
  const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "image/*,text/html;q=0.8", "User-Agent": "ChalkIconFetcher/1.0" } });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    const next = response.headers.get("Location");
    return next ? { kind: "redirect", url: new URL(next, url) } : STOP;
  }
  if (!response.ok || !response.body) return STOP;
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body.cancel();
    return STOP;
  }
  const bytes = await readCapped(response.body, limit);
  return bytes ? { kind: "body", bytes } : STOP;
}

/** GET with the guards applied to every hop: public https hosts only, redirects followed by hand, a deadline, and a byte cap. Null means "no usable answer". */
async function get(fetcher: IconFetcher, start: URL, limit: number): Promise<{ readonly url: URL; readonly bytes: Bytes } | null> {
  let url = start;
  try {
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const step = await hop(fetcher, url, limit);
      if (step.kind === "stop") return null;
      if (step.kind === "body") return { url, bytes: step.bytes };
      url = step.url;
    }
    return null;
  } catch (error) {
    console.warn(JSON.stringify({ event: "dashboard.favicon_fetch_failed", host: start.hostname, error_type: error instanceof Error ? error.name : typeof error }));
    return null;
  }
}

async function iconOf(host: string, fetcher: IconFetcher): Promise<Bytes | null> {
  const direct = await get(fetcher, new URL(`https://${host}/favicon.ico`), ICON_LIMIT);
  if (direct && sniffImage(direct.bytes)) return direct.bytes;
  const page = await get(fetcher, new URL(`https://${host}/`), PAGE_LIMIT);
  if (!page) return null;
  for (const href of declaredIcons(new TextDecoder().decode(page.bytes)).slice(0, PAGE_ICONS_TRIED)) {
    let target: URL;
    try {
      target = new URL(href, page.url);
    } catch {
      continue;
    }
    const icon = await get(fetcher, target, ICON_LIMIT);
    if (icon && sniffImage(icon.bytes)) return icon.bytes;
  }
  return null;
}

/** The site's own icon, else its registrable parent's. */
async function findIcon(host: string, fetcher: IconFetcher): Promise<Bytes | null> {
  const own = await iconOf(host, fetcher);
  if (own) return own;
  const parent = registrableParent(host);
  return parent ? iconOf(parent, fetcher) : null;
}

function reply(icon: Bytes | null): Response {
  const type = icon ? sniffImage(icon) : null;
  const headers = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin" };
  if (!icon || !type) return new Response(null, { status: 204, headers: { ...headers, "Cache-Control": `private, max-age=${MISSING_SECONDS}` } });
  return new Response(icon, { headers: { ...headers, "Content-Type": type, "Cache-Control": `private, max-age=${FOUND_SECONDS}` } });
}

function hasDefaultCache(storage: CacheStorage): storage is CacheStorage & { readonly default: IconCache } {
  return "default" in storage;
}

/** Cloudflare's shared edge cache, or null where the runtime has none (tests, local Node). */
export function edgeCache(): IconCache | null {
  return typeof caches !== "undefined" && hasDefaultCache(caches) ? caches.default : null;
}

/** The icon for `host`, from the shared cache when it holds one, else fetched once and remembered (a miss too, for an hour). */
export async function favicon(hostInput: string, deps: FaviconDeps): Promise<Response> {
  const host = publicHostname(hostInput);
  if (!host) throw new DashboardError(400, "invalid_host");
  const key = new Request(`https://favicon.chalk.invalid/${host}`);
  const stored = await deps.cache?.match(key);
  if (stored) return reply(stored.status === 200 ? new Uint8Array(await stored.arrayBuffer()) : null);
  const icon = await findIcon(host, deps.fetcher);
  const lifetime = icon ? FOUND_SECONDS : MISSING_SECONDS;
  await deps.cache?.put(key, new Response(icon, { status: icon ? 200 : 204, headers: { "Cache-Control": `public, max-age=${lifetime}` } }));
  return reply(icon);
}
