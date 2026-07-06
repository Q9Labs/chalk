import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/new")({ component: BlankPage });

function BlankPage() {
  return null;
}
