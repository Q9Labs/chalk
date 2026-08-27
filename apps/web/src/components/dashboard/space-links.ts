import type { DashboardSpace, DashboardSpacePublicInvite } from "../../lib/dashboard-api";

export type SpaceHrefBuilder = (space: Pick<DashboardSpace, "slug">) => string;

/**
 * Builds the participant-facing Space URL used by dashboard affordances.
 * Keep this injectable so an embedding app can provide its own Space route.
 */
export const defaultSpaceHrefBuilder: SpaceHrefBuilder = (space) => `/space/${encodeURIComponent(space.slug)}?entry=dashboard`;

export function dashboardSpaceHref(space: Pick<DashboardSpace, "id">): string {
  return `/spaces/${encodeURIComponent(space.id)}`;
}

/**
 * Returns the server-issued public URL. The canonical URL owns the invite
 * fragment, so this helper deliberately leaves it untouched.
 */
export function publicSpaceHrefBuilder(invite: Pick<DashboardSpacePublicInvite, "canonical_url">): string | undefined {
  const href = invite.canonical_url?.trim();
  return href || undefined;
}

export function episodeHistoryHref(episode: { space_id: string; id: string }): string {
  const params = new URLSearchParams({ space: episode.space_id, episode: episode.id });
  return `/episodes?${params.toString()}`;
}
