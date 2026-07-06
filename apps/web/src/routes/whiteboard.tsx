import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/whiteboard")({ component: BlankPage });

function BlankPage() {
  return null;
}
