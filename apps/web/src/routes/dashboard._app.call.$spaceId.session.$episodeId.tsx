import { createFileRoute } from "@tanstack/react-router";

import { PastSessionPage } from "../components/dashboard/PastSessionPage";

export const Route = createFileRoute("/dashboard/_app/call/$spaceId/session/$episodeId")({ component: PastSessionRoute });

function PastSessionRoute() {
  const { spaceId, episodeId } = Route.useParams();
  return <PastSessionPage key={episodeId} spaceId={spaceId} episodeId={episodeId} />;
}
