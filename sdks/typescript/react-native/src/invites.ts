const CHALK_INVITE_HOSTS: readonly string[] = ["chalkmeet.com", "chalk.q9labs.ai"];
const CHALK_CUSTOM_PROTOCOLS = new Set(["chalk:", "ai.q9labs.chalk.mobile:"]);
const SPACE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SPACE_INVITE_TOKEN_PATTERN = /^cspi1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export type SpaceInviteLink = {
  readonly slug: string;
  readonly spaceInviteToken: string;
};

export function parseSpaceInviteLink(input: string): SpaceInviteLink | null {
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
    if (!CHALK_CUSTOM_PROTOCOLS.has(parsed.protocol) && !isAllowedWebInviteOrigin(parsed)) {
      return null;
    }
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    if (CHALK_CUSTOM_PROTOCOLS.has(parsed.protocol)) pathSegments.unshift(parsed.hostname);
    if (pathSegments.length !== 2 || pathSegments[0] !== "space") return null;

    const slug = pathSegments[1];
    const token = new URLSearchParams(parsed.hash.replace(/^#/u, "")).get("spaceInviteToken")?.trim();
    return slug && token && token.length <= 512 && SPACE_SLUG_PATTERN.test(slug) && SPACE_INVITE_TOKEN_PATTERN.test(token) ? { slug, spaceInviteToken: token } : null;
  } catch {
    return null;
  }
}

function isChalkInviteHost(hostname: string): boolean {
  return CHALK_INVITE_HOSTS.some((host) => host === hostname);
}

function isAllowedWebInviteOrigin(url: URL): boolean {
  if (url.protocol === "https:") return isChalkInviteHost(url.hostname);
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function extractSpaceInviteFromLink(input: string): SpaceInviteLink | null {
  return parseSpaceInviteLink(input);
}

export function getClipboardInviteSuggestion(clipboardText: string | null | undefined, currentInput = ""): string | null {
  const normalizedClipboardText = clipboardText?.trim();
  if (!normalizedClipboardText) {
    return null;
  }

  if (normalizedClipboardText === currentInput.trim()) {
    return null;
  }

  return parseSpaceInviteLink(normalizedClipboardText) ? normalizedClipboardText : null;
}
