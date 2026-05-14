import { extractJoinTokenFromInviteLink as extractJoinTokenFromInviteLinkCore } from "@q9labs/chalk-core";

export const extractJoinTokenFromInviteLink = extractJoinTokenFromInviteLinkCore;

export function getClipboardInviteSuggestion(clipboardText: string | null | undefined, currentInput = ""): string | null {
  const normalizedClipboardText = clipboardText?.trim();
  if (!normalizedClipboardText) {
    return null;
  }

  if (normalizedClipboardText === currentInput.trim()) {
    return null;
  }

  return extractJoinTokenFromInviteLink(normalizedClipboardText) ? normalizedClipboardText : null;
}
