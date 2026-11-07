import { createFileRoute } from "@tanstack/react-router";

import { ConnectMissing, ConnectPage } from "../components/dashboard/ConnectPage";

type Search = { readonly request?: string };

// Standalone like sign-in: an app sent the person here, so the dashboard frame stays out of it.
export const Route = createFileRoute("/dashboard/connect")({
  validateSearch: (search): Search => ({ request: typeof search.request === "string" ? search.request : undefined }),
  component: ConnectRoute,
});

function ConnectRoute() {
  const { request } = Route.useSearch();
  return request ? <ConnectPage request={request} /> : <ConnectMissing />;
}
