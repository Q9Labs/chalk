const CHALK_INVITE_HOSTS = ["chalkmeet.com", "chalk.q9labs.ai"] as const;
const CHALK_CUSTOM_PROTOCOLS = new Set(["chalk:", "ai.q9labs.chalk.mobile:"]);
const capabilityPattern = /^[A-Za-z0-9_-]{43}$/u;

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
    if (!CHALK_CUSTOM_PROTOCOLS.has(parsed.protocol) && (parsed.protocol !== "https:" || !CHALK_INVITE_HOSTS.includes(parsed.hostname as (typeof CHALK_INVITE_HOSTS)[number]))) {
      return null;
    }
    const pathSegments = CHALK_CUSTOM_PROTOCOLS.has(parsed.protocol) ? [parsed.hostname, ...parsed.pathname.split("/").filter(Boolean)] : parsed.pathname.split("/").filter(Boolean);
    const [head, tail] = pathSegments;
    const hashInvite = new URLSearchParams(parsed.hash.replace(/^#/u, "")).get("meeting");
    const token = head === "j" && tail ? tail : hashInvite?.trim();

    return token && capabilityPattern.test(token) ? token : null;
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
