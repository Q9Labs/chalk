import { createFileRoute } from "@tanstack/react-router";
import { SpacePage } from "../components/space/SpacePage";

export const Route = createFileRoute("/space/$slug")({
  component: PublicSpaceRoute,
});

function PublicSpaceRoute() {
  const { slug } = Route.useParams();
  return <SpacePage slug={slug} />;
}
