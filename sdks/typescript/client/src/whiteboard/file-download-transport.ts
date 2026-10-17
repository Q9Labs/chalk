import { ChalkWhiteboardV1Error, type ChalkWhiteboardV1Failure, type ChalkWhiteboardV1FileTransport } from "./types";

export type ChalkWhiteboardV1FileDownloadTransportOptions = {
  readonly baseUrl: string;
  readonly token: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
};

export function createChalkWhiteboardV1FileDownloadTransport(options: ChalkWhiteboardV1FileDownloadTransportOptions): ChalkWhiteboardV1FileTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  let baseUrlEnd = options.baseUrl.length;
  while (baseUrlEnd > 0 && options.baseUrl[baseUrlEnd - 1] === "/") baseUrlEnd -= 1;
  const baseUrl = options.baseUrl.slice(0, baseUrlEnd);

  return {
    getDownloadUrl: async (fileId) => {
      const response = await authorizedFetch(fetchImplementation, options.token, `${baseUrl}/v1/whiteboard/files/${encodeURIComponent(fileId)}/download`, { method: "GET" });
      if (!response.ok) throw await responseError(response, "get_file_download");
      const value: unknown = await response.json();
      if (!isDownloadResponse(value)) {
        throw whiteboardError("get_file_download", "file_transfer_failed", false, "Whiteboard download service returned an invalid response.");
      }
      return value;
    },
  };
}

async function authorizedFetch(fetchImplementation: typeof globalThis.fetch, token: () => Promise<string>, url: string, init: RequestInit): Promise<Response> {
  try {
    const authorization = await token();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${authorization}`);
    return await fetchImplementation(url, { ...init, headers });
  } catch (cause) {
    throw new ChalkWhiteboardV1Error(
      {
        operation: "get_file_download",
        code: "storage_unavailable",
        recoverable: true,
        message: "Whiteboard file storage is unavailable.",
      },
      { cause },
    );
  }
}

async function responseError(response: Response, operation: ChalkWhiteboardV1Failure["operation"]): Promise<ChalkWhiteboardV1Error> {
  const code = response.status === 401 || response.status === 403 ? "permission_denied" : response.status === 400 ? "invalid_payload" : response.status >= 500 || response.status === 429 ? "storage_unavailable" : "file_transfer_failed";
  return whiteboardError(operation, code, response.status >= 500 || response.status === 429, "Whiteboard file request failed.");
}

function whiteboardError(operation: ChalkWhiteboardV1Failure["operation"], code: ChalkWhiteboardV1Failure["code"], recoverable: boolean, message: string): ChalkWhiteboardV1Error {
  return new ChalkWhiteboardV1Error({ operation, code, recoverable, message });
}

function isDownloadResponse(value: unknown): value is {
  readonly downloadUrl: string;
  readonly expiresAt: string;
} {
  return isExactObject(value, ["downloadUrl", "expiresAt"]) && isHttpUrl(value.downloadUrl) && isDate(value.expiresAt);
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
