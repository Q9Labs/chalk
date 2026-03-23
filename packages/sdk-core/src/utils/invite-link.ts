const CHALK_INVITE_HOST = "chalk.q9labs.ai";

export function extractJoinTokenFromInviteLink(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.includes("://")
    ? trimmed
    : trimmed.startsWith(`${CHALK_INVITE_HOST}/`)
      ? `https://${trimmed}`
      : null;

  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    const pathSegments =
      parsed.protocol === "chalk:"
        ? [parsed.hostname, ...parsed.pathname.split("/").filter(Boolean)]
        : parsed.pathname.split("/").filter(Boolean);
    const [head, tail] = pathSegments;

    if (head !== "j" || !tail) {
      return null;
    }

    return tail;
  } catch {
    return null;
  }
}

export function isCanonicalRoomId(roomId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    roomId.trim(),
  );
}
