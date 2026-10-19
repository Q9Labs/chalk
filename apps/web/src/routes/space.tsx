import { createFileRoute, useLocation, useMatch } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { SpacePage } from "../components/space/SpacePage";
import { SITE_ORIGIN } from "../lib/site-head";

export const Route = createFileRoute("/space")({
  head: ({ match }) => ({
    meta: [{ name: "apple-itunes-app", content: `app-id=6760978704, app-argument=${new URL(match.pathname, SITE_ORIGIN).href}` }],
  }),
  component: SpaceRoute,
});

function SpaceRoute() {
  const href = useLocation({ select: (location) => location.href });
  useEffect(() => {
    const banner = document.querySelector<HTMLMetaElement>('head meta[name="apple-itunes-app"]');
    if (banner) banner.content = `app-id=6760978704, app-argument=${new URL(href, window.location.origin).href}`;
  }, [href]);
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
  return <SpacePage slug={slug} navigatePublicSpace={navigatePublicSpace} />;
}
