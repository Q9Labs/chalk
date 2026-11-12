import { createFileRoute } from "@tanstack/react-router";

import { legacyListRoute } from "../lib/dashboard/search";

export const Route = createFileRoute("/dashboard/_app/sessions")(legacyListRoute());
