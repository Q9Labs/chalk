// Seeds the stack through the API's system token: one Tenant and Space on the stack's plane (the Chalk SFU, or Cloudflare when
// the stack has real Cloudflare credentials) and an API key, then writes the
// values a proof run reads to <dir>/proof.env.
//
// The Nightly host proof seeds a deployed host the same way: <dir>/system-token then holds the host's service secret (a service
// principal owns the Tenants it creates), CHALK_SEED_PLANE names the plane because the host's api.env is not on this machine, and
// CHALK_SEED_TENANT_CORS_ORIGINS lists origins the Tenant allows, since the host's deployment origins do not include the proof's, and
// CHALK_SEED_WEB_URL is the web origin when it is not the API's.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, apiOrigin, proofOrigin, publicOrigin] = process.argv.slice(2);
const systemToken = readFileSync(join(dir, "system-token"), "utf8");
// identity.mjs wrote the plane new Spaces land on; the Tenant and the proof Space follow it.
const plane = "chalk_sfu";

async function send(method, path, body) {
  const response = await fetch(new URL(path, apiOrigin), {
    method,
    headers: { authorization: `Bearer ${systemToken}`, "content-type": "application/json", "Idempotency-Key": `nightly-stack-${randomUUID()}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`seed ${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
const post = (path, body) => send("POST", path, body);

const tenant = await post("/v1/tenants", { name: "Nightly stack", default_media_plane: plane });
const corsOrigins = (process.env.CHALK_SEED_TENANT_CORS_ORIGINS ?? "").split(",").filter(Boolean);
if (corsOrigins.length > 0) await send("PATCH", `/v1/tenants/${tenant.id}`, { cors_allowed_origins: corsOrigins });
const space = await post(`/v1/tenants/${tenant.id}/spaces`, {
  name: "Nightly proofs",
  slug: "nightly-proofs",
  media_plane: plane,
  recording_policy: "manual",
  transcription_policy: "on_demand",
  default_episode_duration_seconds: 1800,
  maximum_episode_duration_seconds: 1800,
  linger_window_seconds: 900,
});
// The scopes scripts/prod-proof/README.md lists for the bootstrap key: each proof run mints its own narrower key from it.
const scopes = ["api_keys:write", "api_keys:delete", "spaces:read", "spaces:write", "episodes:read", "episodes:write", "recordings:read", "transcriptions:read", "transcriptions:write", "transcriptions:delete", "webhooks:write"];
const key = await post(`/v1/tenants/${tenant.id}/api-keys`, { name: "Nightly proofs", scopes, expires_at: new Date(Date.now() + 86400000).toISOString() });

const values = {
  CHALK_PROOF_CONFIG_SOURCE: "env",
  CHALK_PROOF_API_URL: publicOrigin,
  CHALK_PROOF_WEB_URL: process.env.CHALK_SEED_WEB_URL ?? publicOrigin,
  CHALK_PROOF_PROOF_ORIGIN: proofOrigin,
  // The proofs that run on this stack send no webhooks; the harness still requires both values.
  CHALK_PROOF_WEBHOOK_SERVICE_URL: proofOrigin,
  CHALK_PROOF_WEBHOOK_ENDPOINT_ID: "unused",
  CHALK_PROOF_MEDIA_PLANE: plane,
  CHALK_PROOF_API_KEY: key.secret ?? key.api_key ?? key.key,
  CHALK_PROOF_TENANT_ID: tenant.id,
  [`CHALK_PROOF_SPACE_ID_${plane.toUpperCase()}`]: space.id,
};
if (!values.CHALK_PROOF_API_KEY) throw new Error(`seed: the API key response had no secret (fields: ${Object.keys(key).join(", ")})`);
writeFileSync(
  join(dir, "proof.env"),
  `${Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`,
  { mode: 0o600 },
);
