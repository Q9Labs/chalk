import type { DashboardBindings } from "./config";
import { handleDashboard } from "./application";
import { oauthProvider } from "./oauth";
export const onRequest: PagesFunction<DashboardBindings> = (context) =>
  handleDashboard(context.request, context.env, (env) => {
    if (env.DASHBOARD_IDENTITY_PROVIDER !== "oauth") throw new Error("Deployed entrypoint does not support fixture identity");
    return oauthProvider(env);
  });
