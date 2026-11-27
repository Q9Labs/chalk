import { createFileRoute } from "@tanstack/react-router";

import { HandoverPage } from "../components/dashboard/HandoverPage";

// Standalone like connect: the handover recipient may need to switch account before accepting.
export const Route = createFileRoute("/dashboard/handover/$handoverId")({
  component: HandoverRoute,
});

function HandoverRoute() {
  const { handoverId } = Route.useParams();
  return <HandoverPage handoverId={handoverId} />;
}
