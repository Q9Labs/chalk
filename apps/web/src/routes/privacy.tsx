import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({ component: BlankPage });

function BlankPage() {
  return null;
}
