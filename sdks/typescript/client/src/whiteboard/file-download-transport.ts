import { WhiteboardV1ProtocolMetadata } from "../generated/whiteboard-v1";
import { ChalkWhiteboardV1Error, type ChalkWhiteboardV1Failure, type ChalkWhiteboardV1FileTransport, type ChalkWhiteboardV1FileUpload } from "./types";
import { isDownloadResponse } from "../chat-files/http-transport";
import { withRequestContext } from "../session";
import * as apiUrls from "./file-urls";

export type ChalkWhiteboardV1FileDownloadTransportOptions = {
  readonly baseUrl: string;
  readonly token: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
};

type UploadInstructions = { readonly ready: true } | { readonly ready: false; readonly uploadUrl: string; readonly headers: Record<string, string> };

export function createChalkWhiteboardV1FileDownloadTransport(options: ChalkWhiteboardV1FileDownloadTransportOptions): ChalkWhiteboardV1FileTransport {
  const fetchImplementation = withRequestContext(options.fetch);
  const objectFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request(operation: ChalkWhiteboardV1Failure["operation"], url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${await options.token()}`);
      response = await fetchImplementation(url, { ...init, headers });
    } catch (cause) {
      throw new ChalkWhiteboardV1Error({ operation, code: "storage_unavailable", recoverable: true, message: "Whiteboard file storage is unavailable." }, { cause });
    }
    if (!response.ok) throw responseError(response, operation);
    return response;
  }

  async function uploadFile(input: ChalkWhiteboardV1FileUpload): Promise<void> {
    const { sceneId, fileId, signal } = input;
    const operation = "upload_file";
    const { body, mimeType, byteLength, sha256 } = await uploadPayload(input);
    const post = { method: "POST", headers: { "content-type": "application/json" }, signal };
    const response = await request(operation, apiUrls.whiteboardFileUpload(options.baseUrl, sceneId, fileId), {
      ...post,
      body: JSON.stringify({ mimeType, byteLength, sha256 }),
    });
    const instructions: unknown = await response.json();
    if (!isUploadInstructions(instructions)) {
      throw whiteboardError(operation, "file_transfer_failed", false, "Whiteboard upload service returned an invalid response.");
    }
    if (instructions.ready) return;

    // A lost response or a conditional-create conflict can mean the bytes already arrived.
    // Only finalize can confirm that the stored bytes match this request.
    const upload = await objectFetch(instructions.uploadUrl, {
      method: "PUT",
      headers: instructions.headers,
      body,
      signal,
      credentials: "omit",
      redirect: "error",
    }).catch(() => null);
    if (rejectsUpload(upload)) {
      throw whiteboardError(operation, "file_transfer_failed", false, "Whiteboard image upload was rejected.");
    }
    await request(operation, apiUrls.whiteboardFileFinalize(options.baseUrl, sceneId, fileId), { ...post, body: JSON.stringify({ sha256 }) });
  }

  return {
    uploadFile,
    getDownloadUrl: async (fileId) => {
      const response = await request("get_file_download", apiUrls.whiteboardFileDownload(options.baseUrl, fileId), { method: "GET" });
      const value: unknown = await response.json();
      if (!isDownloadResponse(value)) {
        throw whiteboardError("get_file_download", "file_transfer_failed", false, "Whiteboard download service returned an invalid response.");
      }
      return value;
    },
  };
}

const rasterMimeTypes = new Set<string>(WhiteboardV1ProtocolMetadata.fileTransport.uploadMimeTypes);

async function uploadPayload(input: ChalkWhiteboardV1FileUpload) {
  const body = "blob" in input ? input.blob : input.bytes;
  const mimeType = "blob" in input ? input.blob.type : input.mimeType;
  const byteLength = body instanceof Uint8Array ? body.byteLength : body.size;
  if (byteLength <= 0 || byteLength > WhiteboardV1ProtocolMetadata.fileTransport.maxUploadBytes || !rasterMimeTypes.has(mimeType)) {
    throw whiteboardError("upload_file", "invalid_payload", false, "Choose a PNG, JPEG, GIF or WebP image under 20 MB.");
  }
  const sha256 = "blob" in input ? await blobDigest(input.blob) : input.sha256;
  return { body, mimeType, byteLength, sha256 };
}

function rejectsUpload(response: Response | null): boolean {
  if (!response || response.ok) return false;
  return response.status < 500 && ![409, 412].includes(response.status);
}

function isUploadInstructions(value: unknown): value is UploadInstructions {
  if (typeof value !== "object" || value === null || !("ready" in value)) return false;
  if (value.ready === true) return true;
  return value.ready === false && validUploadDestination(value);
}

function validUploadDestination(value: object): boolean {
  return "uploadUrl" in value && isHttpUrl(value.uploadUrl) && "headers" in value && isHeaderRecord(value.headers);
}

function isHttpUrl(url: unknown): boolean {
  if (typeof url !== "string" || !URL.canParse(url)) return false;
  return ["https:", "http:"].includes(new URL(url).protocol);
}

function isHeaderRecord(headers: unknown): boolean {
  return typeof headers === "object" && headers !== null && !Array.isArray(headers) && Object.values(headers).every((header: unknown) => typeof header === "string");
}

function responseError(response: Response, operation: ChalkWhiteboardV1Failure["operation"]): ChalkWhiteboardV1Error {
  const recoverable = response.status >= 500 || response.status === 429;
  const code = response.status === 401 || response.status === 403 ? "permission_denied" : response.status === 400 ? "invalid_payload" : recoverable ? "storage_unavailable" : "file_transfer_failed";
  return whiteboardError(operation, code, recoverable, "Whiteboard file request failed.");
}

function whiteboardError(operation: ChalkWhiteboardV1Failure["operation"], code: ChalkWhiteboardV1Failure["code"], recoverable: boolean, message: string): ChalkWhiteboardV1Error {
  return new ChalkWhiteboardV1Error({ operation, code, recoverable, message });
}

async function blobDigest(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
