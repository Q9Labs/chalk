import { createFileRoute } from "@tanstack/react-router";
import { useDashboardAccount } from "../components/dashboard/DashboardAccount";
import { SpacesPage } from "../components/dashboard/SpacesPage";

export const Route = createFileRoute("/_app/spaces")({
  component: () => {
    const { current } = useDashboardAccount();
    return <SpacesPage tenantID={current.tenant.id} />;
  },
});
