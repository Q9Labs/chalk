import { createFileRoute } from "@tanstack/react-router";

import { AiAppsPage } from "../components/dashboard/AiAppsPage";

export const Route = createFileRoute("/dashboard/_app/apps")({ component: AiAppsPage });
