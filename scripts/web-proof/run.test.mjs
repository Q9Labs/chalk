import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("./run.mjs", import.meta.url));

async function runProof(status) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/readyz") {
      response.writeHead(status).end(JSON.stringify({ capabilities: { recording: "disabled", transcription: "disabled" } }));
    } else {
      // Stop at the external resource boundary; no browser or real call is needed.
      response.writeHead(403).end(JSON.stringify({ error: { code: "access.forbidden" } }));
    }
  });
  const directory = await mkdtemp(join(tmpdir(), "chalk-web-readiness-"));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const environment = {
      ...process.env,
      CHALK_PROOF_CONFIG_SOURCE: "env",
      CHALK_PROOF_API_KEY: "chalk_sk_fixture_only",
      CHALK_PROOF_TENANT_ID: "fixture-tenant",
      CHALK_PROOF_API_URL: `http://127.0.0.1:${server.address().port}`,
      CHALK_PROOF_WEB_URL: "https://web.example.test",
      CHALK_PROOF_PROOF_ORIGIN: "http://127.0.0.1:4567",
      CHALK_PROOF_WEBHOOK_SERVICE_URL: "https://catcher.example.test",
      CHALK_PROOF_WEBHOOK_ENDPOINT_ID: "fixture-endpoint",
    };
    await assert.rejects(execute(process.execPath, [entry], { cwd: directory, env: environment, timeout: 10_000, killSignal: "SIGKILL" }), (error) => {
      assert.equal(error.code, 1);
      return true;
    });
    return requests;
  } finally {
    server.closeAllConnections();
    await new Promise((accept) => server.close(accept));
    await rm(directory, { recursive: true, force: true });
  }
}

test("web proof starts call setup on a healthy backend with media features disabled", async () => {
  const requests = await runProof(200);
  assert.deepEqual(requests.slice(0, 2), ["GET /readyz", "POST /v1/tenants/fixture-tenant/api-keys"]);
});

test("web proof refuses an unhealthy API before creating call resources", async () => {
  assert.deepEqual(await runProof(503), ["GET /readyz"]);
});
