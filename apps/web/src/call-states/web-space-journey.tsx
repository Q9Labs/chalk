import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "../lib/theme-context";
import { SpacePage } from "../components/space/SpacePage";
import "../styles.css";

const path = "/space/design-lab?name=Ada#spaceInviteToken=cspi1.fixture";
history.replaceState({}, "", path);
const rootRoute = createRootRoute({
  component: () => (
    <ThemeProvider>
      <Outlet />
    </ThemeProvider>
  ),
});
const spaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/space/$slug", component: () => <SpacePage slug="design-lab" /> });
const router = createRouter({ routeTree: rootRoute.addChildren([spaceRoute]), history: createMemoryHistory({ initialEntries: [path] }) });
const root = document.getElementById("root");
if (!root) throw new Error("Web journey root is missing");
createRoot(root).render(<RouterProvider router={router} />);
