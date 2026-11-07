import { createFileRoute } from "@tanstack/react-router";

import { PrivacyNotice } from "../components/privacy/PrivacyNotice";
import { OwnerCall } from "../components/dashboard/OwnerCall";
import { useSiteTheme } from "../components/site/theme";

export const Route = createFileRoute("/dashboard_/call/$spaceId/join")({
  head: () => ({ meta: [{ title: "Chalk" }, { name: "robots", content: "noindex" }] }),
  component: JoinRoute,
});

function JoinRoute() {
  const { spaceId } = Route.useParams();
  const { theme } = useSiteTheme();
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <div data-chalk data-chalk-theme={theme} className="relative z-10 shrink-0">
        <PrivacyNotice overCall />
      </div>
      <div className="relative min-h-0 flex-1">
        <OwnerCall key={spaceId} spaceId={spaceId} />
      </div>
    </div>
  );
}
