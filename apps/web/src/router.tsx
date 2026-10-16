import { createRoute, createRouter, lazyRouteComponent } from "@tanstack/react-router";
import type { AnyRoute } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

const diagnosticsRouteEnabled = typeof __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__ === "undefined" ? false : __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__;
const diagnosticsRoutePath = "developer/episode-diagnostics/$reference";

const activeRouteTree = (() => {
  if (!diagnosticsRouteEnabled) return routeTree;

  // TanStack's generated route tree types preserve the file-route child map,
  // while the runtime normalizes children to an array. Keep this cast local
  // so we can augment the generated tree without editing generated output.
  const rootChildren = (routeTree.children ?? []) as readonly AnyRoute[];
  {
    const diagnosticsAlreadyRegistered = rootChildren.some((route) => "path" in route.options && route.options.path === diagnosticsRoutePath);
    if (diagnosticsAlreadyRegistered) return routeTree;

    const episodeDiagnosticsRoute = createRoute({
      getParentRoute: () => routeTree,
      path: diagnosticsRoutePath,
      component: lazyRouteComponent(() => import("./features/episode-debugger/EpisodeDebuggerScreen")),
    });
    return routeTree.addChildren([...rootChildren, episodeDiagnosticsRoute]);
  }
})();

export const getRouter = () =>
  createRouter({
    routeTree: activeRouteTree,
    context: {},
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });
