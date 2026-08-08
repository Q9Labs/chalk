import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../components/legal/LegalPage";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Privacy Policy | Chalk" }] }),
  component: () => <LegalPage kind="privacy" />,
});
