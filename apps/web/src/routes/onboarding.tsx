import { createFileRoute } from "@tanstack/react-router";
import { TenantOnboarding } from "../components/dashboard/TenantOnboarding";

export const Route = createFileRoute("/onboarding")({ component: TenantOnboarding });
