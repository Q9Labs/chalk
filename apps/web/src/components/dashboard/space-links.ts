import type { DashboardSpace } from "../../lib/dashboard-api";

export type SpaceHrefBuilder = (space: Pick<DashboardSpace, "slug">) => string;

/**
 * Builds the participant-facing Space URL used by dashboard affordances.
 * Keep this injectable so an embedding app can provide its own Space route.
 */
export const defaultSpaceHrefBuilder: SpaceHrefBuilder = (space) => `/space/${encodeURIComponent(space.slug)}`;

export function dashboardSpaceHref(space: Pick<DashboardSpace, "id">): string {
  return `/spaces/${encodeURIComponent(space.id)}`;
}

export function episodeHistoryHref(episode: { space_id: string; id: string }): string {
  const params = new URLSearchParams({ space: episode.space_id, episode: episode.id });
  return `/episodes?${params.toString()}`;
}
