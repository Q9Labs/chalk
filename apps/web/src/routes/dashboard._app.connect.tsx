import { createFileRoute } from "@tanstack/react-router";

import { ConnectPage } from "../components/dashboard/ConnectPage";

type Search = { readonly request?: string };

export const Route = createFileRoute("/dashboard/_app/connect")({
  validateSearch: (search): Search => ({ request: typeof search.request === "string" ? search.request : undefined }),
  component: ConnectRoute,
});

function ConnectRoute() {
  const { request } = Route.useSearch();
  return request ? <ConnectPage request={request} /> : <p className="ohelp">Open this page from the app you want to connect.</p>;
}
