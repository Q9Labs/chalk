import { verifyStrictAutoplayUnlock } from "./strict-autoplay.mjs";

export async function runChromiumEntry(browser, baseURL, tenantAPIKey, { autoplayOnly, runMatrix, executablePath, autoplayHelpers }) {
  if (!autoplayOnly) await runMatrix(browser, baseURL, tenantAPIKey);
  await verifyStrictAutoplayUnlock(baseURL, executablePath, autoplayHelpers);
}
