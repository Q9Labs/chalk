import { createFileRoute } from "@tanstack/react-router";

import { PrivacyNotice } from "../components/privacy/PrivacyNotice";
import { OwnerCall } from "../components/dashboard/OwnerCall";

export const Route = createFileRoute("/dashboard_/call/$spaceId/join")({
  head: () => ({ meta: [{ title: "Chalk" }, { name: "robots", content: "noindex" }] }),
  component: JoinRoute,
});

function JoinRoute() {
  const { spaceId } = Route.useParams();
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <div className="shrink-0">
        <PrivacyNotice />
      </div>
      <div className="relative min-h-0 flex-1">
        <OwnerCall key={spaceId} spaceId={spaceId} />
      </div>
    </div>
  );
}
