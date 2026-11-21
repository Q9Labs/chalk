export const WHITEBOARD_MAX_FILE_BYTES = 20 * 1024 * 1024;

export function decodeWhiteboardImageDataURL(dataURL: string): { readonly mimeType: string; readonly bytes: Uint8Array<ArrayBuffer> } {
  const separator = dataURL.indexOf(",");
  const prefix = /^data:(image\/(?:png|jpeg|gif|webp));base64$/u.exec(dataURL.slice(0, separator));
  const mimeType = prefix?.[1];
  if (!mimeType || dataURL.length - separator - 1 > Math.ceil(WHITEBOARD_MAX_FILE_BYTES / 3) * 4) {
    throw new Error("Choose a PNG, JPEG, GIF or WebP image under 20 MB.");
  }
  const binary = atob(dataURL.slice(separator + 1));
  if (!binary.length || binary.length > WHITEBOARD_MAX_FILE_BYTES) throw new Error("Whiteboard image size is invalid.");
  return { mimeType, bytes: Uint8Array.from(binary, (byte) => byte.charCodeAt(0)) };
}
