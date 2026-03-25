const CHALK_INVITE_HOSTS = ["chalkmeet.com", "chalk.q9labs.ai"] as const;

export function extractJoinTokenFromInviteLink(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.includes("://")
    ? trimmed
    : CHALK_INVITE_HOSTS.some((host) => trimmed.startsWith(`${host}/`))
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
