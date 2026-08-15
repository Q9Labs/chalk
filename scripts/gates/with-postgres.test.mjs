import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "with-postgres.sh");
const script = readFileSync(scriptPath, "utf8");
const databaseAliases = [
  "CHALK_DATABASE_URL",
  "CHALK_CHAT_ATTACHMENT_TEST_DATABASE_URL",
  "CHALK_EPISODE_DIAGNOSTICS_TEST_DATABASE_URL",
  "CHALK_PROVIDER_BRIDGE_E2E_DATABASE_URL",
  "CHALK_SPACE_LIFECYCLE_TEST_DATABASE_URL",
  "CHALK_STATUS_TEST_DATABASE_URL",
  "CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL",
  "CHALK_SYNC_TEST_DATABASE_URL",
  "CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL",
  "CHALK_WEBHOOK_TEST_DATABASE_URL",
  "CHALK_WHITEBOARD_TEST_DATABASE_URL",
];

test("isolated Postgres exports every API database test alias", () => {
  assert.match(script, /export CHALK_API_ENV=local/);
  assert.match(script, /export CHALK_GATE_POSTGRES_READY=1/);
  for (const alias of databaseAliases) {
    assert.match(script, new RegExp(`export ${alias}="\\$\\{database_url\\}"`), alias);
  }
});

test("isolated Postgres keeps migrations on the same database URL", () => {
  assert.match(script, /CHALK_DATABASE_URL="\$\{database_url\}" .*db-migrate\.sh/);
  assert.match(script, /export CHALK_DATABASE_URL="\$\{database_url\}"/);
});
