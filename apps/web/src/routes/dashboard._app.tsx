import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AppShell } from "../components/dashboard/AppShell";

export const Route = createFileRoute("/dashboard/_app")({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
