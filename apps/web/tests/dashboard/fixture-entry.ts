import { handleDashboard } from "../../server/application";
import { configuration } from "../../server/config";
import type { DashboardBindings } from "../../server/config";
import { fixtureProvider, fixtureRoute } from "./fixture-provider";
export const onRequest: PagesFunction<DashboardBindings> = (context) => {
  const env = configuration(context.env);
  if (new URL(context.request.url).pathname.startsWith("/fixture/")) return fixtureRoute(context.request, env);
  return handleDashboard(context.request, context.env, fixtureProvider);
};
