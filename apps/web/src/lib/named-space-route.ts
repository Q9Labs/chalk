export function spaceInviteToken(): string | undefined {
  if (!globalThis.location) return undefined;
  const value = new URLSearchParams(globalThis.location.hash.slice(1)).get("spaceInviteToken")?.trim();
  return value || undefined;
}

export function hasDashboardSpaceEntry(): boolean {
  if (!globalThis.location) return false;
  return new URLSearchParams(globalThis.location.search).get("entry") === "dashboard";
}

export function clearDashboardSpaceEntry(): void {
  if (!globalThis.location || !globalThis.history || !hasDashboardSpaceEntry()) return;
  const url = new URL(globalThis.location.href);
  url.searchParams.delete("entry");
  globalThis.history.replaceState(globalThis.history.state, "", url);
}

export function canonicalSpaceInviteLink(slug: string, inviteLink: string): string {
  const value = inviteLink.trim();
  if (!value) throw new Error("The Space invite link was empty.");

  const origin = globalThis.location?.origin ?? "https://chalkmeet.com";
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

export function replaceWithSpaceInviteLink(slug: string, inviteLink: string): string {
  const canonical = canonicalSpaceInviteLink(slug, inviteLink);
  if (globalThis.history) globalThis.history.replaceState(globalThis.history.state, "", canonical);
  return canonical;
}

export function replaceWithVerifiedSpaceInviteLink(slug: string, inviteLink: string): string {
  const value = verifiedSpaceInviteLink(slug, inviteLink);
  if (globalThis.history) globalThis.history.replaceState(globalThis.history.state, "", value);
  return value;
}

function verifiedSpaceInviteLink(slug: string, inviteLink: string): string {
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
  if (url.pathname !== `/space/${encodeURIComponent(slug)}`) throw new Error("The Space invite link did not match the verified Space.");

  const token = new URLSearchParams(url.hash.slice(1)).get("spaceInviteToken")?.trim();
  if (!token?.startsWith("cspi1.")) throw new Error("The Space invite link did not contain a valid capability.");
  return value;
}
