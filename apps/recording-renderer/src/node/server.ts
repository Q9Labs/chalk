import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { extname, join, relative, sep } from "node:path";
import type { VerifiedFileBinding, VerifiedRenderInputs } from "./inputs.js";

const CONTENT_SECURITY_POLICY = ["default-src 'self'", "connect-src 'self'", "font-src 'self'", "img-src 'self' blob: data:", "media-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join("; ");
const STATIC_CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

export interface RenderServer {
  readonly origin: string;
  close(): Promise<void>;
}

export async function startRenderServer(inputs: VerifiedRenderInputs, clientDirectory: string): Promise<RenderServer> {
  const clientRoot = await realpath(clientDirectory);
  const server = createServer((request, response) => {
    void handleRequest(inputs, clientRoot, request.method ?? "GET", request.url ?? "/", request.headers.range, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      response.writeHead(500, responseHeaders("text/plain; charset=utf-8", 21));
      response.end("render server failed\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("recording render server did not bind a loopback port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function handleRequest(inputs: VerifiedRenderInputs, clientRoot: string, method: string, rawUrl: string, range: string | undefined, response: ServerResponse): Promise<void> {
  if (!isSupportedMethod(method)) {
    response.writeHead(405, { Allow: "GET, HEAD", ...responseHeaders("text/plain; charset=utf-8", 19) });
    response.end("method not allowed\n");
    return;
  }
  const url = new URL(rawUrl, "http://127.0.0.1");
  return serveRequestedResource(inputs, clientRoot, method, url.pathname, range, response);
}

function isSupportedMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

async function serveRequestedResource(inputs: VerifiedRenderInputs, clientRoot: string, method: string, pathname: string, range: string | undefined, response: ServerResponse): Promise<void> {
  if (pathname === "/runtime/input") {
    serveRuntimeInput(inputs, method, response);
    return;
  }
  const runtimeBinding = findRuntimeBinding(inputs, pathname);
  if (runtimeBinding === null) return notFound(response);
  if (runtimeBinding !== undefined) return serveFile(runtimeBinding, method, range, response);

  return serveStaticFile(clientRoot, pathname, method, range, response);
}

function serveRuntimeInput(inputs: VerifiedRenderInputs, method: string, response: ServerResponse): void {
  const body = Buffer.from(JSON.stringify({ presentation: inputs.timeline, decodedMedia: inputs.decodedMediaDocument }), "utf8");
  response.writeHead(200, responseHeaders("application/json", body.byteLength));
  response.end(method === "HEAD" ? undefined : body);
}

function findRuntimeBinding(inputs: VerifiedRenderInputs, pathname: string): VerifiedFileBinding | null | undefined {
  const assetId = endpointIdentifier(pathname, "/runtime/assets/");
  if (assetId !== undefined) return findBinding(inputs.assets, assetId);
  const sourceId = endpointIdentifier(pathname, "/runtime/media/");
  if (sourceId !== undefined) return findBinding(inputs.mediaFiles, sourceId);
  return undefined;
}

function findBinding(bindings: ReadonlyMap<string, VerifiedFileBinding>, identifier: string): VerifiedFileBinding | null {
  const binding = bindings.get(identifier);
  if (binding === undefined) return null;
  return binding;
}

async function serveStaticFile(clientRoot: string, pathname: string, method: string, range: string | undefined, response: ServerResponse): Promise<void> {
  const relativePath = clientRelativePath(pathname);
  const candidate = await realpath(join(clientRoot, relativePath));
  const pathFromRoot = relative(clientRoot, candidate);
  if (escapesRoot(pathFromRoot)) return notFound(response);
  const facts = await stat(candidate);
  if (!facts.isFile()) return notFound(response);
  return serveFile({ path: candidate, contentType: staticContentType(candidate), byteSize: facts.size }, method, range, response);
}

function clientRelativePath(pathname: string): string {
  return pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
}

function escapesRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`);
}

async function serveFile(binding: VerifiedFileBinding, method: string, rangeHeader: string | undefined, response: ServerResponse): Promise<void> {
  const range = parseRange(rangeHeader, binding.byteSize);
  if (isUnsatisfiableRange(rangeHeader, range)) {
    response.writeHead(416, { ...responseHeaders("text/plain; charset=utf-8", 22), "Content-Range": `bytes */${binding.byteSize}` });
    response.end("range not satisfiable\n");
    return;
  }
  const selection = selectFileRange(range, binding.byteSize);
  response.writeHead(selection.status, fileResponseHeaders(binding, selection));
  if (method === "HEAD") {
    response.end();
    return;
  }
  await streamFile(binding.path, selection.start, selection.end, response);
}

function isUnsatisfiableRange(rangeHeader: string | undefined, range: ByteRange | undefined): boolean {
  return rangeHeader !== undefined && range === undefined;
}

interface SelectedFileRange extends ByteRange {
  readonly status: 200 | 206;
  readonly contentRange?: string;
}

function selectFileRange(range: ByteRange | undefined, size: number): SelectedFileRange {
  if (range === undefined) return { start: 0, end: size - 1, status: 200 };
  return { ...range, status: 206, contentRange: `bytes ${range.start}-${range.end}/${size}` };
}

function fileResponseHeaders(binding: VerifiedFileBinding, selection: SelectedFileRange): OutgoingHttpHeaders {
  const headers = responseHeaders(binding.contentType, selection.end - selection.start + 1);
  headers["Accept-Ranges"] = "bytes";
  if (selection.contentRange !== undefined) headers["Content-Range"] = selection.contentRange;
  return headers;
}

async function streamFile(path: string, start: number, end: number, response: ServerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { start, end });
    stream.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

function responseHeaders(contentType: string, contentLength: number): OutgoingHttpHeaders {
  return {
    "Cache-Control": "no-store",
    "Content-Length": String(contentLength),
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Content-Type": contentType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  };
}

function endpointIdentifier(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const encoded = pathname.slice(prefix.length);
  if (encoded.length === 0 || encoded.includes("/")) return undefined;
  return decodeURIComponent(encoded);
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function parseRange(value: string | undefined, size: number): ByteRange | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (match === null) return undefined;
  return parseRangeMatch(match, size);
}

function parseRangeMatch(match: RegExpExecArray, size: number): ByteRange | undefined {
  const endText = match[2];
  const start = parseRangeOffset(match[1], size);
  if (start === undefined) return undefined;
  const end = parseRangeEnd(endText, size);
  if (end === undefined) return undefined;
  if (end < start) return undefined;
  return { start, end };
}

function parseRangeOffset(value: string | undefined, size: number): number | undefined {
  if (value === undefined) return undefined;
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) return undefined;
  if (offset >= size) return undefined;
  return offset;
}

function parseRangeEnd(value: string | undefined, size: number): number | undefined {
  if (value === undefined) return size - 1;
  if (value === "") return size - 1;
  return parseRangeOffset(value, size);
}

function staticContentType(path: string): string {
  return STATIC_CONTENT_TYPES.get(extname(path)) ?? "application/octet-stream";
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, responseHeaders("text/plain; charset=utf-8", 10));
  response.end("not found\n");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
}
