import { createFileRoute, Outlet } from "@tanstack/react-router";

import { ToastProvider } from "../components/dashboard/kit";
import { SiteRoot } from "../components/site/theme";
import coreCss from "../styles/dashboard-core.css?url";
import dashboardCss from "../styles/dashboard.css?url";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [{ title: "Chalk" }, { name: "robots", content: "noindex" }],
    links: [
      { rel: "stylesheet", href: coreCss },
      { rel: "stylesheet", href: dashboardCss },
    ],
  }),
  component: DashboardRoute,
});

function DashboardRoute() {
  return (
    <SiteRoot>
      <div className="dash">
        <ToastProvider>
          <Outlet />
        </ToastProvider>
      </div>
    </SiteRoot>
  );
}
