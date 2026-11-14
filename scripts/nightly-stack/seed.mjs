// Seeds the stack through the API's system token: one Tenant and Space on the Chalk SFU and an API key, then writes the
// values a proof run reads to <dir>/proof.env.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, apiOrigin, proofOrigin] = process.argv.slice(2);
const systemToken = readFileSync(join(dir, "system-token"), "utf8");

async function call(method, path, body) {
  const response = await fetch(new URL(path, apiOrigin), {
    method,
    headers: { authorization: `Bearer ${systemToken}`, ...(body ? { "content-type": "application/json" } : {}), ...(method === "POST" ? { "Idempotency-Key": `nightly-stack-${randomUUID()}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`seed ${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const tenant = await call("POST", "/v1/tenants", { name: "Nightly stack", default_media_plane: "chalk_sfu" });
const space = await call("POST", `/v1/tenants/${tenant.id}/spaces`, { name: "Nightly proofs", slug: "nightly-proofs", media_plane: "chalk_sfu" });
// The scopes scripts/prod-proof/README.md lists for the bootstrap key: each proof run mints its own narrower key from it.
const scopes = [
  "api_keys:write", "api_keys:delete", "spaces:read", "spaces:write", "episodes:read", "episodes:write",
  "recordings:read", "transcriptions:read", "transcriptions:write", "transcriptions:delete", "webhooks:write",
];
const key = await call("POST", `/v1/tenants/${tenant.id}/api-keys`, { name: "Nightly proofs", scopes, expires_at: new Date(Date.now() + 86400000).toISOString() });

const values = {
  CHALK_PROOF_CONFIG_SOURCE: "env",
  CHALK_PROOF_API_URL: apiOrigin,
  CHALK_PROOF_WEB_URL: apiOrigin,
  CHALK_PROOF_PROOF_ORIGIN: proofOrigin,
  // The proofs that run on this stack send no webhooks; the harness still requires both values.
  CHALK_PROOF_WEBHOOK_SERVICE_URL: proofOrigin,
  CHALK_PROOF_WEBHOOK_ENDPOINT_ID: "unused",
  CHALK_PROOF_MEDIA_PLANE: "chalk_sfu",
  CHALK_PROOF_API_KEY: key.secret ?? key.api_key ?? key.key,
  CHALK_PROOF_TENANT_ID: tenant.id,
  CHALK_PROOF_SPACE_ID_CHALK_SFU: space.id,
};
if (!values.CHALK_PROOF_API_KEY) throw new Error(`seed: the API key response had no secret (fields: ${Object.keys(key).join(", ")})`);
writeFileSync(join(dir, "proof.env"), `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
