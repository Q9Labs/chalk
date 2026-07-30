export interface NativeChatViewport {
  readonly contentHeight: number;
  readonly viewportHeight: number;
  readonly scrollOffset: number;
}

const LATEST_MESSAGE_VISIBILITY_TOLERANCE = 8;

export function isLatestChatMessageVisible({ contentHeight, viewportHeight, scrollOffset }: NativeChatViewport): boolean {
  if (contentHeight <= 0 || viewportHeight <= 0) return false;
  return scrollOffset + viewportHeight >= contentHeight - LATEST_MESSAGE_VISIBILITY_TOLERANCE;
}

export function formatChatAttachmentSize(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${formatUnit(byteLength / 1024)} KB`;
  if (byteLength < 1024 * 1024 * 1024) return `${formatUnit(byteLength / (1024 * 1024))} MB`;
  return `${formatUnit(byteLength / (1024 * 1024 * 1024))} GB`;
}

function formatUnit(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}
