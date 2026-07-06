const CHALK_INVITE_HOSTS = ["chalkmeet.com", "chalk.q9labs.ai"] as const;
const CHALK_CUSTOM_PROTOCOLS = new Set(["chalk:", "ai.q9labs.chalk.mobile:"]);

export function extractJoinTokenFromInviteLink(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.includes("://") ? trimmed : CHALK_INVITE_HOSTS.some((host) => trimmed.startsWith(`${host}/`)) ? `https://${trimmed}` : null;
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    const pathSegments = CHALK_CUSTOM_PROTOCOLS.has(parsed.protocol) ? [parsed.hostname, ...parsed.pathname.split("/").filter(Boolean)] : parsed.pathname.split("/").filter(Boolean);
    const [head, tail] = pathSegments;

    return head === "j" && tail ? tail : null;
  } catch {
    return null;
  }
}

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
