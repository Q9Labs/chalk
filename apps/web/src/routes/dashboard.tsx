import { createFileRoute, Outlet } from "@tanstack/react-router";

import { ToastProvider } from "../components/dashboard/kit";
import { SiteRoot } from "../components/site/theme";

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Chalk" }, { name: "robots", content: "noindex" }] }),
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
