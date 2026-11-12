import { redirect } from "@tanstack/react-router";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The Sessions and Recordings pages are gone; their old links still carry a call filter. Parsed by hand: the router
 * loads this with the public call route, and a schema library would add about 25 KiB gzip there.
 */
export type LegacyListSearch = { readonly spaceId?: string | undefined };

export const parseLegacyListSearch = (search: Record<string, unknown>): LegacyListSearch => ({ spaceId: typeof search.spaceId === "string" && UUID.test(search.spaceId) ? search.spaceId : undefined });

/** The old list routes: a link filtered to one call opens that call, where its sessions, recordings and transcripts live. Others open Home. */
export const legacyListRoute = {
  validateSearch: parseLegacyListSearch,
  beforeLoad: ({ search }: { readonly search: LegacyListSearch }) => {
    if (search.spaceId) throw redirect({ to: "/dashboard/call/$spaceId", params: { spaceId: search.spaceId }, replace: true });
    throw redirect({ to: "/dashboard", replace: true });
  },
};
