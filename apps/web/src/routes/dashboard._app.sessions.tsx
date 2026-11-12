import { createFileRoute, redirect } from "@tanstack/react-router";

import { parseLegacyListSearch } from "../lib/dashboard/search";

/** The old sessions list: a link filtered to one call opens that call, where its sessions, recordings and transcripts live. Others open Home. */
export const Route = createFileRoute("/dashboard/_app/sessions")({
  validateSearch: parseLegacyListSearch,
  beforeLoad: ({ search }) => {
    if (search.spaceId) throw redirect({ to: "/dashboard/call/$spaceId", params: { spaceId: search.spaceId }, replace: true });
    throw redirect({ to: "/dashboard", replace: true });
  },
});
