import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../components/legal/LegalPage";
import { buildPublicSiteHead } from "../lib/site-head";

export const Route = createFileRoute("/terms")({
  head: () =>
    buildPublicSiteHead({
      path: "/terms",
      title: "Terms of Service | Chalk",
      description: "Read the terms that govern Chalk accounts, Tenants, Spaces, Episodes, APIs, SDKs, and customer content.",
      imageAlt: "Chalk terms of service preview",
    }),
  component: () => <LegalPage kind="terms" />,
});
