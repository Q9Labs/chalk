import { createFileRoute } from "@tanstack/react-router";
import { LegalDocumentPage } from "../features/legal/LegalDocumentPage";
import { TERMS_OF_SERVICE_DOCUMENT } from "../features/legal/legalDocuments";

export const Route = createFileRoute("/terms")({
  component: TermsOfService,
});

function TermsOfService() {
  return <LegalDocumentPage document={TERMS_OF_SERVICE_DOCUMENT} />;
}
