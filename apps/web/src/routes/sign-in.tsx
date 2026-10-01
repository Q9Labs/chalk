import { createFileRoute } from "@tanstack/react-router";
import { safeReturnPath } from "../lib/return-path";
import { AuthPage } from "../components/dashboard/AuthPage";

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: { next?: unknown }): { next?: string } => ({ next: safeReturnPath(search.next) }),
  component: () => <AuthPage mode="sign-in" next={Route.useSearch().next} />,
});
