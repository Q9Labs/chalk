import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVACY_POLICY_DOCUMENT, TERMS_OF_SERVICE_DOCUMENT } from "../src/features/legal/legalDocuments";
import { renderLegacyPrivacyPolicyRedirectPage, renderStaticLegalPage } from "../src/features/legal/staticLegalPages";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(scriptDir, "../public");

function writePublicFile(relativePath: string, contents: string) {
  const outputPath = resolve(publicDir, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents);
}

writePublicFile("privacy/index.html", renderStaticLegalPage(PRIVACY_POLICY_DOCUMENT));
writePublicFile("terms/index.html", renderStaticLegalPage(TERMS_OF_SERVICE_DOCUMENT));
writePublicFile("privacy-policy/index.html", renderLegacyPrivacyPolicyRedirectPage());
