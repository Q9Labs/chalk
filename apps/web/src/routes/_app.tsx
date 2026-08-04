import { createFileRoute } from "@tanstack/react-router";
import { DashboardShell } from "../components/dashboard/DashboardShell";
import { DashboardAccountGate } from "../components/dashboard/DashboardAccount";

export const Route = createFileRoute("/_app")({
  component: () => (
    <DashboardAccountGate>
      <DashboardShell />
    </DashboardAccountGate>
  ),
});
