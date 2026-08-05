import { createFileRoute } from "@tanstack/react-router";

import { SpacePage } from "../components/space/SpacePage";

export const Route = createFileRoute("/space")({ component: SpacePage });
