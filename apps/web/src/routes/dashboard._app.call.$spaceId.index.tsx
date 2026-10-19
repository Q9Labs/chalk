import { createFileRoute } from "@tanstack/react-router";

import { CallPage } from "../components/dashboard/CallPage";

export const Route = createFileRoute("/dashboard/_app/call/$spaceId/")({ component: CallRoute });

function CallRoute() {
  const { spaceId } = Route.useParams();
  return <CallPage key={spaceId} spaceId={spaceId} />;
}
