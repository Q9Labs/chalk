import { createFileRoute } from "@tanstack/react-router";
import { LegalDocumentPage } from "../features/legal/LegalDocumentPage";
import { PRIVACY_POLICY_DOCUMENT } from "../features/legal/legalDocuments";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPolicy,
});

function PrivacyPolicy() {
  return <LegalDocumentPage document={PRIVACY_POLICY_DOCUMENT} />;
}
