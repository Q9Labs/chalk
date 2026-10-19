import { check } from "../prod-proof/runtime.mjs";

export function childEnvironment(environment, { config, apiKey, invite, directory, runId, webUrl }) {
  return {
    ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "PLAYWRIGHT_BROWSERS_PATH", "CI"].filter((name) => environment[name] !== undefined).map((name) => [name, environment[name]])),
    E2E_TELEMETRY_DISABLED: "1",
    CHALK_PROOF_WEB_URL: webUrl,
    CHALK_E2E_API_URL: config.api_url,
    CHALK_E2E_TENANT_ID: config.tenant_id,
    CHALK_E2E_PROOF_ORIGIN: config.proof_origin,
    CHALK_E2E_INVITE: invite,
    CHALK_E2E_DIRECTORY: directory,
    CHALK_E2E_API_KEY: apiKey,
    CHALK_E2E_RUN_ID: runId,
  };
}

export function guestConfig(environment) {
  const config = {
    api_key: environment.CHALK_E2E_API_KEY,
    api_url: environment.CHALK_E2E_API_URL,
    tenant_id: environment.CHALK_E2E_TENANT_ID,
    web_url: environment.CHALK_PROOF_WEB_URL,
    proof_origin: environment.CHALK_E2E_PROOF_ORIGIN,
  };
  for (const [name, value] of Object.entries(config)) check(value, `SDK guest configuration is missing ${name}`, "configuration");
  check(config.api_key.startsWith("chalk_sk_"), "SDK guest API key must use the chalk_sk_ namespace", "configuration");
  return config;
}
