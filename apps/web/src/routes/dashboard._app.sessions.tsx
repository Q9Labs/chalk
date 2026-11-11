import { createFileRoute } from "@tanstack/react-router";

import { SessionsPage } from "../components/dashboard/SessionsPage";
import { parseSessionsSearch } from "../lib/dashboard/search";

export const Route = createFileRoute("/dashboard/_app/sessions")({ validateSearch: parseSessionsSearch, component: SessionsRoute });

function SessionsRoute() {
  return <SessionsPage search={Route.useSearch()} />;
}
