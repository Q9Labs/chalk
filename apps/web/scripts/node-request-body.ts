import type { IncomingMessage } from "node:http";

export async function readBoundedNodeBody(request: IncomingMessage, maxBytes: number, errorMessage: string): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new Error(errorMessage);
    chunks.push(bytes);
  }

  const body = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}
