import { createFileRoute, useMatch } from "@tanstack/react-router";
import { useCallback } from "react";

import { SpacePage } from "../components/space/SpacePage";

export const Route = createFileRoute("/space")({ component: SpaceRoute });

function SpaceRoute() {
  const slug = useMatch({ from: "/space/$slug", shouldThrow: false, select: (match) => match.params.slug });
  const navigate = Route.useNavigate();
  const navigatePublicSpace = useCallback(
    async (canonicalSlug: string, inviteLink: string) => {
      const inviteURL = new URL(inviteLink);
      await navigate({ to: "/space/$slug", params: { slug: canonicalSlug }, hash: inviteURL.hash.slice(1), replace: true });
    },
    [navigate],
  );
  return <SpacePage slug={slug} navigatePublicSpace={navigatePublicSpace} />;
}
