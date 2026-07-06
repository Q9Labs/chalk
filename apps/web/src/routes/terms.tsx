import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({ component: BlankPage });

function BlankPage() {
  return null;
}
