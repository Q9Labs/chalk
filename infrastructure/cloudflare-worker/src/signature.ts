import { createHmac, timingSafeEqual } from "node:crypto"

export const SIGNATURE_HEADER = "X-Chalk-Signature"
export const TIMESTAMP_HEADER = "X-Chalk-Timestamp"
export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000

export function generateSignature(secret: string, timestamp: number, payload: string): string {
  const message = `${timestamp}.${payload}`
  const hmac = createHmac("sha256", secret)
  hmac.update(message)
  return `sha256=${hmac.digest("hex")}`
}

export function verifySignature(secret: string, timestamp: number, payload: string, signature: string): boolean {
  const expected = generateSignature(secret, timestamp, payload)
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

export function isTimestampFresh(timestamp: number, now = Date.now()): boolean {
  return Math.abs(now - timestamp * 1000) <= MAX_SIGNATURE_AGE_MS
}
