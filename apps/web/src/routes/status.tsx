import { createFileRoute } from "@tanstack/react-router";
import { StatusPage } from "../components/status/StatusPage";
import { buildPublicSiteHead } from "../lib/site-head";

export const Route = createFileRoute("/status")({
  head: () =>
    buildPublicSiteHead({
      path: "/status",
      title: "Status | Chalk",
      description: "Live system status, incidents, uptime, and maintenance updates for Chalk.",
      imageAlt: "Chalk service status preview",
    }),
  component: StatusPage,
});
