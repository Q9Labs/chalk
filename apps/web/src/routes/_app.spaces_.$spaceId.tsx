import { createFileRoute } from "@tanstack/react-router";
import { useDashboardAccount } from "../components/dashboard/DashboardAccount";
import { SpaceDetailPage } from "../components/dashboard/SpaceDetailPage";

export const Route = createFileRoute("/_app/spaces_/$spaceId")({
  component: () => {
    const { current } = useDashboardAccount();
    const { spaceId } = Route.useParams();
    return <SpaceDetailPage tenantID={current.tenant.id} spaceID={spaceId} />;
  },
});
