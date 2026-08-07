export function decodeBase64Url(value: string): string {
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(globalThis.atob(base64), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
