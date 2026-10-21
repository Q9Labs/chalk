import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../components/legal/LegalPage";
import { buildPublicSiteHead } from "../lib/site-head";

export const Route = createFileRoute("/privacy_/previous")({
  head: () =>
    buildPublicSiteHead({
      path: "/privacy/previous",
      title: "Previous Privacy Policy | Chalk",
      description: "The previous Chalk Privacy Policy, effective 7 August 2026.",
      imageAlt: "Chalk previous privacy policy",
    }),
  component: () => <LegalPage kind="privacy-previous" />,
});
