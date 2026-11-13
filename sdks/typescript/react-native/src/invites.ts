import { parseChalkInviteLink } from "@q9labsai/chalk-client/invites";

export { buildSpaceInviteLink as buildChalkInviteLink, parseChalkInviteLink, parseSpaceInviteLink, parseSpaceInviteLink as extractSpaceInviteFromLink } from "@q9labsai/chalk-client/invites";
export type { ChalkInviteLink, SpaceInviteLink } from "@q9labsai/chalk-client/invites";

export function getClipboardInviteSuggestion(clipboardText: string | null | undefined, currentInput = ""): string | null {
  const normalizedClipboardText = clipboardText?.trim();
  if (!normalizedClipboardText || normalizedClipboardText === currentInput.trim()) return null;
  return parseChalkInviteLink(normalizedClipboardText) ? normalizedClipboardText : null;
}
