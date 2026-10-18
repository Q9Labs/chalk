import { createFileRoute, useLocation, useMatch } from "@tanstack/react-router";
import { useCallback } from "react";

import { SpacePage } from "../components/space/SpacePage";

export const Route = createFileRoute("/space")({ component: SpaceRoute });

function SpaceRoute() {
  const href = useLocation({ select: (location) => location.href });
  const appArgument = typeof window === "undefined" ? undefined : new URL(href, window.location.origin).href;
  const match = useMatch({ from: "/space/$slug", shouldThrow: false });
  const slug = match?.params.slug;
  const navigate = Route.useNavigate();
  const navigatePublicSpace = useCallback(
    async (canonicalSlug: string, inviteLink: string) => {
      const inviteURL = new URL(inviteLink);
      await navigate({ to: "/space/$slug", params: { slug: canonicalSlug }, hash: inviteURL.hash.slice(1), replace: true });
    },
    [navigate],
  );
  return (
    <>
      {appArgument && <meta name="apple-itunes-app" content={`app-id=6760978704, app-argument=${appArgument}`} />}
      <SpacePage slug={slug} navigatePublicSpace={navigatePublicSpace} />
    </>
  );
}
