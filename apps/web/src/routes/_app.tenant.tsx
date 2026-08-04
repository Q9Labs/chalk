import { createFileRoute } from "@tanstack/react-router";
import { TenantSettingsPage } from "../components/dashboard/TenantSettingsPage";
export const Route = createFileRoute("/_app/tenant")({ component: TenantSettingsPage });
