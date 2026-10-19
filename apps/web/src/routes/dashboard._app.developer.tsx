import { createFileRoute } from "@tanstack/react-router";

import { DeveloperPage } from "../components/dashboard/DeveloperPage";

export const Route = createFileRoute("/dashboard/_app/developer")({ component: DeveloperPage });
