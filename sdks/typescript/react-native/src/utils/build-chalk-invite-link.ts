const PUBLIC_INVITE_ORIGIN = "https://chalkmeet.com";

export function buildChalkInviteLink(spaceSlug: string, spaceInviteToken: string, origin = PUBLIC_INVITE_ORIGIN): string {
  const link = new URL(`/space/${encodeURIComponent(spaceSlug)}`, origin.replace(/\/+$/u, ""));
  link.hash = new URLSearchParams({ spaceInviteToken }).toString();
  return link.toString();
}
