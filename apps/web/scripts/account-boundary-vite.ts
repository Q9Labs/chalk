import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { handleAccountBoundary } from "../src/server/account-boundary";
import { readBoundedNodeBody } from "./node-request-body";

export function accountBoundaryVitePlugin(webOrigin: string): Plugin {
  return {
    name: "chalk-account-boundary",
    configureServer(server) {
      server.middlewares.use("/api", async (request, response, next) => {
        try {
          const webRequest = await toWebRequest(request, webOrigin);
          const webResponse = await handleAccountBoundary(webRequest, {
            CHALK_API_ORIGIN: process.env.CHALK_DEV_API_ORIGIN?.trim() || "http://127.0.0.1:8080",
          });
          await writeNodeResponse(response, webResponse);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

async function toWebRequest(request: IncomingMessage, webOrigin: string): Promise<Request> {
  const method = request.method ?? "GET";
  const headers = new Headers(flattenHeaders(request.headers));
  const body = method === "GET" || method === "HEAD" ? undefined : await readBoundedNodeBody(request, 64 * 1024, "account boundary request body exceeds local adapter limit");
  return new Request(new URL(`/api${request.url ?? ""}`, webOrigin), { method, headers, body });
}

function flattenHeaders(headers: IncomingHttpHeaders): HeadersInit {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result[name] = value.join(", ");
    else if (value !== undefined) result[name] = value;
  }
  return result;
}

async function writeNodeResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  const headers = webResponse.headers as Headers & { getSetCookie?: () => string[] };
  const combinedSetCookie = headers.get("set-cookie");
  const setCookies = headers.getSetCookie?.() ?? (combinedSetCookie ? [combinedSetCookie] : []);
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "set-cookie") response.setHeader(name, value);
  }
  if (setCookies.length > 0) response.setHeader("set-cookie", setCookies);
  const body = new Uint8Array(await webResponse.arrayBuffer());
  response.end(body);
}
