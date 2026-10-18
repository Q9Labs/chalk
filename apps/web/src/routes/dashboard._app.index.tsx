import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "../components/dashboard/HomePage";

export const Route = createFileRoute("/dashboard/_app/")({ component: HomePage });
