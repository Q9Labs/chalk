import { createFileRoute } from "@tanstack/react-router";
import { useDashboardAccount } from "../components/dashboard/DashboardAccount";
import { EpisodesPage } from "../components/dashboard/EpisodesPage";

export const Route = createFileRoute("/_app/episodes")({
  component: () => {
    const { current } = useDashboardAccount();
    return <EpisodesPage tenantID={current.tenant.id} />;
  },
});
