import { parseInviteCode } from "@q9labsai/chalk-client";

export function spaceInviteToken(): string | undefined {
  if (!globalThis.location) return undefined;
  const value = new URLSearchParams(globalThis.location.hash.slice(1)).get("spaceInviteToken")?.trim();
  return value || undefined;
}

export function canonicalSpaceInviteLink(slug: string, credential: string): string {
  const value = credential.trim();
  if (!value) throw new Error("The Space invite link was empty.");

  const origin = globalThis.location?.origin ?? "https://chalkmeet.com";
  const code = parseInviteCode(value);
  if (code) return new URL(`/${code}`, origin).toString();
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) throw new Error("The Space invite link used an unexpected origin.");
    if (url.hash.includes("spaceInviteToken=")) return url.toString();
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("unexpected origin")) throw cause;
  }

  const url = new URL(`/space/${encodeURIComponent(slug)}`, origin);
  url.hash = new URLSearchParams({ spaceInviteToken: value }).toString();
  return url.toString();
}

export function verifiedSpaceInviteLink(slug: string, inviteLink: string): string {
  const value = inviteLink.trim();
  if (!value) throw new Error("The Space invite link was empty.");

  const origin = globalThis.location?.origin ?? "https://chalkmeet.com";
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    throw new Error("The Space invite link was invalid.");
  }
  if (url.origin !== origin) throw new Error("The Space invite link used an unexpected origin.");
  const code = parseInviteCode(url.pathname.slice(1));
  if (code && url.pathname === `/${code}` && !url.search && !url.hash) return value;
  if (url.pathname !== `/space/${encodeURIComponent(slug)}`) throw new Error("The Space invite link did not match the verified Space.");

  const token = new URLSearchParams(url.hash.slice(1)).get("spaceInviteToken")?.trim();
  if (!token?.startsWith("cspi1.")) throw new Error("The Space invite link did not contain a valid capability.");
  return value;
}
