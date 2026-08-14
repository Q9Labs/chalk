import { createFileRoute } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { DashboardSpacePage } from "../components/space/SpacePage";
import { consumeDashboardSpaceEntry } from "../lib/named-space-route";

export const Route = createFileRoute("/space/$slug")({
  component: DashboardSpaceRoute,
});

function DashboardSpaceRoute() {
  const { slug } = Route.useParams();
  useLayoutEffect(consumeDashboardSpaceEntry, []);
  return <DashboardSpacePage slug={slug} />;
}
