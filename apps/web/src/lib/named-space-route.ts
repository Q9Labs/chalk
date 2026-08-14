/**
 * Dashboard links mark account-bound entry. Consume that marker and any stale
 * broker invite before entry while leaving public invite links unchanged.
 */
export function consumeDashboardSpaceEntry(): void {
  if (!globalThis.location || !globalThis.history) return;

  const url = new URL(globalThis.location.href);
  if (url.searchParams.get("entry") !== "dashboard") return;

  url.searchParams.delete("entry");
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.delete("spaceInviteToken");
  url.hash = fragment.toString();

  globalThis.history.replaceState(globalThis.history.state, "", url);
}
