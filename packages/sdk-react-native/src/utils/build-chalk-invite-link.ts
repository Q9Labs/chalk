const PUBLIC_INVITE_ORIGIN = "https://chalkmeet.com";

export function buildChalkInviteLink(joinToken: string, origin = PUBLIC_INVITE_ORIGIN): string {
  return `${origin.replace(/\/+$/, "")}/j/${joinToken}`;
}
