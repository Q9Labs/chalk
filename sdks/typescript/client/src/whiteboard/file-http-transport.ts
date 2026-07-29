import { ChalkWhiteboardV1Error, type ChalkWhiteboardV1Failure, type ChalkWhiteboardV1FileTransport } from "./types";

export type ChalkWhiteboardV1FileHttpTransportOptions = {
  readonly baseUrl: string;
  readonly token: () => Promise<string>;
  readonly sceneId: () => string;
  readonly fetch?: typeof globalThis.fetch;
};

export function createChalkWhiteboardV1FileHttpTransport(options: ChalkWhiteboardV1FileHttpTransportOptions): ChalkWhiteboardV1FileTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");

  return {
    initiateUpload: async (input) => {
      const response = await authorizedFetch(fetchImplementation, options.token, `${baseUrl}/v1/whiteboard/files/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, sceneId: options.sceneId() }),
      });
      if (!response.ok) throw await responseError(response, "initiate_file_upload");
      const value: unknown = await response.json();
      if (!isInitiateUploadResponse(value)) {
        throw whiteboardError("initiate_file_upload", "file_transfer_failed", false, "Whiteboard upload service returned an invalid response.");
      }
      return value;
    },
    finalizeUpload: async (uploadId) => {
      const response = await authorizedFetch(fetchImplementation, options.token, `${baseUrl}/v1/whiteboard/files/uploads/${encodeURIComponent(uploadId)}/finalize`, { method: "POST" });
      if (!response.ok) throw await responseError(response, "finalize_file_upload");
    },
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
        operation: operationFromUrl(url),
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

function operationFromUrl(url: string): ChalkWhiteboardV1Failure["operation"] {
  if (url.endsWith("/finalize")) return "finalize_file_upload";
  if (url.endsWith("/download")) return "get_file_download";
  return "initiate_file_upload";
}

function whiteboardError(operation: ChalkWhiteboardV1Failure["operation"], code: ChalkWhiteboardV1Failure["code"], recoverable: boolean, message: string): ChalkWhiteboardV1Error {
  return new ChalkWhiteboardV1Error({ operation, code, recoverable, message });
}

function isInitiateUploadResponse(value: unknown): value is {
  readonly uploadId: string;
  readonly method: "PUT";
  readonly uploadUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
} {
  return isExactObject(value, ["uploadId", "method", "uploadUrl", "headers", "expiresAt"]) && typeof value.uploadId === "string" && value.method === "PUT" && isHttpUrl(value.uploadUrl) && isStringRecord(value.headers) && isDate(value.expiresAt);
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

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");
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
