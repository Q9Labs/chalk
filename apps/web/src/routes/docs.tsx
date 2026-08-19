import { createFileRoute } from "@tanstack/react-router";

import { DocsShell } from "../components/docs/DocsShell";

export const Route = createFileRoute("/docs")({ component: DocsRoute });

function DocsRoute() {
  return <DocsShell />;
}
