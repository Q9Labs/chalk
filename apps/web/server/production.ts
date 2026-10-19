import type { DashboardBindings } from "./config";
import { handleDashboard } from "./application";
import { workosProvider } from "./workos";
export const onRequest: PagesFunction<DashboardBindings> = (context) =>
  handleDashboard(context.request, context.env, (env) => {
    if (env.DASHBOARD_IDENTITY_PROVIDER !== "workos") throw new Error("Deployed entrypoint does not support fixture identity");
    return workosProvider(env);
  });
