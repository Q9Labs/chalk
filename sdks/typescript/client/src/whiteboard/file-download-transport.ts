import { ChalkWhiteboardV1Error, type ChalkWhiteboardV1Failure, type ChalkWhiteboardV1FileTransport } from "./types";
import { isDownloadResponse } from "../chat-files/http-transport";
import { withRequestContext } from "../session";
import * as apiUrls from "../api-urls";

export type ChalkWhiteboardV1FileDownloadTransportOptions = {
  readonly baseUrl: string;
  readonly token: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
};

export function createChalkWhiteboardV1FileDownloadTransport(options: ChalkWhiteboardV1FileDownloadTransportOptions): ChalkWhiteboardV1FileTransport {
  const fetchImplementation = withRequestContext(options.fetch);

  return {
    getDownloadUrl: async (fileId) => {
      const response = await authorizedFetch(fetchImplementation, options.token, apiUrls.whiteboardFileDownload(options.baseUrl, fileId), { method: "GET" });
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
