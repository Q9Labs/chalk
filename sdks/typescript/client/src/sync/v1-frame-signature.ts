import { canonicalJsonBytesFromUnknown } from "./canonical";

export function frameSignature(frame: unknown): string {
  return new TextDecoder().decode(canonicalJsonBytesFromUnknown(frame));
}
