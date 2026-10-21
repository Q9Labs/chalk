import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../components/legal/LegalPage";
import { buildPublicSiteHead } from "../lib/site-head";
import { PRIVACY_ARCHIVE_TITLE } from "../../../shared/privacy-update";

export const Route = createFileRoute("/privacy_/previous")({
  head: () =>
    buildPublicSiteHead({
      path: "/privacy/previous",
      title: `${PRIVACY_ARCHIVE_TITLE} | Chalk`,
      description: PRIVACY_ARCHIVE_TITLE,
      imageAlt: PRIVACY_ARCHIVE_TITLE,
    }),
  component: () => <LegalPage kind="privacy-previous" />,
});
