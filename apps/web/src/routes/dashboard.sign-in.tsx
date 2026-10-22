import { createFileRoute } from "@tanstack/react-router";

import { SignInPage } from "../components/dashboard/SignInPage";
import type { Provider } from "../lib/dashboard/client";

type Search = { readonly returnTo?: string; readonly failed?: Provider };

export const Route = createFileRoute("/dashboard/sign-in")({
  validateSearch: (search): Search => ({
    returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
    failed: search.failed === "google" || search.failed === "apple" ? search.failed : undefined,
  }),
  // Google's button guidelines set its label in Roboto 500. Only this page loads the local label subset.
  head: () => ({ links: [{ rel: "stylesheet", href: "/fonts/sign-in.css" }] }),
  component: SignInRoute,
});

function SignInRoute() {
  const { returnTo, failed } = Route.useSearch();
  return <SignInPage returnTo={returnTo} failed={failed} />;
}
