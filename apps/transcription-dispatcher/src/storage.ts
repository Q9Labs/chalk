import { createHash } from "node:crypto";
import { BodyTooLargeError, readBoundedBody } from "./bounded-body.js";
import { AssignmentError, isRetryableStatus } from "./errors.js";
import type { DispatcherLogger } from "./types.js";

interface FetchVerifiedOptions {
  fetch: typeof fetch;
  url: string;
  expectedContentType: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface VerifiedBytes {
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
}

export async function fetchVerified(options: FetchVerifiedOptions): Promise<VerifiedBytes> {
  const response = await options.fetch(options.url, { method: "GET", ...(options.signal === undefined ? {} : { signal: options.signal }) });
  if (!response.ok) throw new AssignmentError("chunk download failed", isRetryableStatus(response.status));
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType?.toLowerCase() !== options.expectedContentType.toLowerCase()) throw new AssignmentError("chunk content type mismatch");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > options.maxBytes) throw new AssignmentError("chunk exceeded size bound");
  if (declaredLength && Number(declaredLength) !== options.expectedSizeBytes) throw new AssignmentError("chunk size mismatch");
  const bytes = await readBoundedBody(response, options.maxBytes).catch((error: unknown) => {
    throw error instanceof BodyTooLargeError ? new AssignmentError("response exceeded size bound") : error;
  });
  if (bytes.byteLength !== options.expectedSizeBytes) throw new AssignmentError("chunk size mismatch");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== options.expectedSha256.toLowerCase()) throw new AssignmentError("chunk checksum mismatch");
  return { bytes, contentType, sha256 };
}

export async function conditionalPutJson(options: { fetch: typeof fetch; url: string; body: Uint8Array; checksumSha256: string; signal?: AbortSignal }): Promise<"created" | "already_exists"> {
  if (!/^[a-f0-9]{64}$/i.test(options.checksumSha256)) throw new AssignmentError("result checksum is invalid");
  const response = await options.fetch(options.url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "content-length": String(options.body.byteLength),
      "if-none-match": "*",
    },
    body: Buffer.from(options.body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (response.status === 412) return "already_exists";
  if (!response.ok) throw new AssignmentError("result upload failed", isRetryableStatus(response.status));
  return "created";
}

/**
 * Upload a result object. The control plane verifies an object that already
 * exists against this checksum, size and content type before it accepts
 * completion, so a retry after a good PUT and a failed completion is safe.
 */
export async function putResult(options: { fetch: typeof fetch; url: string; body: Uint8Array; maxBytes: number; tooLarge: string; logger: DispatcherLogger; logPrefix: string }): Promise<{ checksumSha256: string; sizeBytes: number }> {
  if (options.body.byteLength > options.maxBytes) throw new AssignmentError(options.tooLarge);
  const checksumSha256 = createHash("sha256").update(options.body).digest("hex");
  const outcome = await conditionalPutJson({ fetch: options.fetch, url: options.url, body: options.body, checksumSha256 });
  if (outcome === "already_exists") options.logger.warn(`${options.logPrefix}_existing_result_verified_by_completion`);
  return { checksumSha256, sizeBytes: options.body.byteLength };
}
