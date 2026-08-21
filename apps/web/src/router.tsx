import { createRoute, createRouter, lazyRouteComponent } from "@tanstack/react-router";
import type { AnyRoute } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { Route as AppRouteImport } from "./routes/_app";

const diagnosticsRouteEnabled = typeof __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__ === "undefined" ? false : __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__;
const diagnosticsMode = typeof __EPISODE_DIAGNOSTICS_MODE__ === "undefined" ? "off" : __EPISODE_DIAGNOSTICS_MODE__;
const diagnosticsRoutePath = "developer/episode-diagnostics/$reference";

const activeRouteTree = (() => {
  if (!diagnosticsRouteEnabled) return routeTree;

  // TanStack's generated route tree types preserve the file-route child map,
  // while the runtime normalizes children to an array. Keep this cast local
  // so we can augment the generated tree without editing generated output.
  const rootChildren = (routeTree.children ?? []) as readonly AnyRoute[];
  if (diagnosticsMode === "localhost") {
    const diagnosticsAlreadyRegistered = rootChildren.some((route) => "path" in route.options && route.options.path === diagnosticsRoutePath);
    if (diagnosticsAlreadyRegistered) return routeTree;

    const episodeDiagnosticsRoute = createRoute({
      getParentRoute: () => routeTree,
      path: diagnosticsRoutePath,
      component: lazyRouteComponent(() => import("./features/episode-debugger/EpisodeDebuggerScreen")),
    });
    return routeTree.addChildren([...rootChildren, episodeDiagnosticsRoute]);
  }

  const dashboardRoute = rootChildren.find((route) => route === AppRouteImport);
  if (!dashboardRoute) throw new Error("Episode Diagnostics route is enabled, but the /_app route was not found");

  const dashboardChildren = (dashboardRoute.children ?? []) as readonly AnyRoute[];
  const diagnosticsAlreadyRegistered = dashboardChildren.some((route) => "path" in route.options && route.options.path === diagnosticsRoutePath);
  if (diagnosticsAlreadyRegistered) return routeTree;

  const episodeDiagnosticsRoute = createRoute({
    getParentRoute: () => dashboardRoute,
    path: diagnosticsRoutePath,
    component: lazyRouteComponent(() => import("./features/episode-debugger/EpisodeDebuggerScreen")),
  });
  const activeDashboardRoute = dashboardRoute.addChildren([...dashboardChildren, episodeDiagnosticsRoute]);
  const activeRootChildren = rootChildren.map((route) => (route === dashboardRoute ? activeDashboardRoute : route));
  return routeTree.addChildren(activeRootChildren);
})();

export const getRouter = () =>
  createRouter({
    routeTree: activeRouteTree,
    context: {},
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });
