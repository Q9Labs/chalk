import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/space")({ component: SpaceRoute });

function SpaceRoute() {
  return <Outlet />;
}
