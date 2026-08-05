import { createFileRoute } from "@tanstack/react-router";
import { useDashboardAccount } from "../components/dashboard/DashboardAccount";
import { APIKeysPage } from "../components/dashboard/APIKeysPage";

export const Route = createFileRoute("/_app/developer")({
  component: () => {
    const { current } = useDashboardAccount();
    return <APIKeysPage tenantID={current.tenant.id} />;
  },
});
