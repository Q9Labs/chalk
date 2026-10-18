import { createFileRoute } from "@tanstack/react-router";

import { OwnerCall } from "../components/dashboard/OwnerCall";

export const Route = createFileRoute("/dashboard_/call/$spaceId/join")({
  head: () => ({ meta: [{ title: "Chalk" }, { name: "robots", content: "noindex" }] }),
  component: JoinRoute,
});

function JoinRoute() {
  const { spaceId } = Route.useParams();
  return <OwnerCall key={spaceId} spaceId={spaceId} />;
}
