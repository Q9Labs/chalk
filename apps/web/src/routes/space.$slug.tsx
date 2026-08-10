import { createFileRoute } from "@tanstack/react-router";
import { DashboardSpacePage } from "../components/space/SpacePage";

export const Route = createFileRoute("/space/$slug")({
  component: () => <DashboardSpacePage slug={Route.useParams().slug} />,
});
