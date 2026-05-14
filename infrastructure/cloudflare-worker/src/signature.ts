const encoder = new TextEncoder()

export const SIGNATURE_HEADER = "X-Chalk-Signature"
export const TIMESTAMP_HEADER = "X-Chalk-Timestamp"
export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000

export async function generateSignature(secret: string, timestamp: number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const message = encoder.encode(`${timestamp}.${payload}`)
  const signature = await crypto.subtle.sign("HMAC", key, message)
  return `sha256=${toHex(new Uint8Array(signature))}`
}

export async function verifySignature(secret: string, timestamp: number, payload: string, signature: string): Promise<boolean> {
  const expected = await generateSignature(secret, timestamp, payload)
  return constantTimeEqual(expected, signature)
}

export function isTimestampFresh(timestamp: number, now = Date.now()): boolean {
  return Math.abs(now - timestamp * 1000) <= MAX_SIGNATURE_AGE_MS
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }

  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return mismatch === 0
}
