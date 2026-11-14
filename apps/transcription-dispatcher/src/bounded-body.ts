/** The body is larger than the caller allows. Callers map this to their own failure type. */
export class BodyTooLargeError extends Error {
  readonly observedBytes: number;

  constructor(observedBytes: number) {
    super("response exceeded size bound");
    this.name = "BodyTooLargeError";
    this.observedBytes = observedBytes;
  }
}

/** Read a response body, stopping as soon as it passes `maxBytes`. */
export async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) throw new BodyTooLargeError(declared);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new BodyTooLargeError(bytes.byteLength);
    return bytes;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      total += next.value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(total);
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
