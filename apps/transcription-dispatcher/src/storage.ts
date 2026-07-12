import { createHash } from "node:crypto";
import { AssignmentError } from "./errors.js";

interface GetAudioOptions {
  fetch: typeof fetch;
  url: string;
  expectedContentType: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface AudioChunk {
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
}

export async function fetchAudioChunk(options: GetAudioOptions): Promise<AudioChunk> {
  const response = await options.fetch(options.url, { method: "GET", ...(options.signal === undefined ? {} : { signal: options.signal }) });
  if (!response.ok) throw new AssignmentError("chunk download failed", response.status === 408 || response.status === 429 || response.status >= 500);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType?.toLowerCase() !== options.expectedContentType.toLowerCase()) throw new AssignmentError("chunk content type mismatch");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > options.maxBytes) throw new AssignmentError("chunk exceeded size bound");
  if (declaredLength && Number(declaredLength) !== options.expectedSizeBytes) throw new AssignmentError("chunk size mismatch");
  const bytes = await boundedResponseBytes(response, options.maxBytes);
  if (bytes.byteLength !== options.expectedSizeBytes) throw new AssignmentError("chunk size mismatch");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== options.expectedSha256.toLowerCase()) throw new AssignmentError("chunk checksum mismatch");
  return { bytes, contentType, sha256 };
}

async function boundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new AssignmentError("response exceeded size bound");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new AssignmentError("response exceeded size bound");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function conditionalPutJson(options: { fetch: typeof fetch; url: string; body: Uint8Array; checksumSha256: string; signal?: AbortSignal }): Promise<"created" | "already_exists"> {
  if (!/^[a-f0-9]{64}$/i.test(options.checksumSha256)) throw new AssignmentError("result checksum is invalid");
  const response = await options.fetch(options.url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "content-length": String(options.body.byteLength),
      "x-amz-checksum-sha256": Buffer.from(options.checksumSha256, "hex").toString("base64"),
      "if-none-match": "*",
    },
    body: Buffer.from(options.body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (response.status === 412) return "already_exists";
  if (!response.ok) throw new AssignmentError("result upload failed", response.status === 408 || response.status === 429 || response.status >= 500);
  return "created";
}
