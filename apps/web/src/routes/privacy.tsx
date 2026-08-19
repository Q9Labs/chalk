import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../components/legal/LegalPage";
import { buildPublicSiteHead } from "../lib/site-head";

export const Route = createFileRoute("/privacy")({
  head: () =>
    buildPublicSiteHead({
      path: "/privacy",
      title: "Privacy Policy | Chalk",
      description: "Learn how Chalk and Q9 Labs collect, use, retain, and protect account, Space, Episode, and Participant data.",
      imageAlt: "Chalk privacy policy preview",
    }),
  component: () => <LegalPage kind="privacy" />,
});
