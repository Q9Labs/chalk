import assert from "node:assert/strict";
import test from "node:test";
import { checkCapabilities, environmentConfig, loadConfig } from "./runtime.mjs";

test("environment configuration maps each named field without interpreting credentials", () => {
  const fields = {
    api_key: "quotes'=$keep",
    tenant_id: "tenant",
    api_url: "https://api.example.test",
    web_url: "https://web.example.test",
    proof_origin: "http://127.0.0.1:4567",
    webhook_service_url: "https://catcher.example.test",
    webhook_endpoint_id: "hook",
  };
  const environment = Object.fromEntries(Object.entries(fields).map(([name, value]) => [`CHALK_PROOF_${name.toUpperCase()}`, value]));
  assert.deepEqual(environmentConfig({ ...environment, PASSWORD: "unrelated" }), fields);
  assert.equal(environmentConfig({}).api_key, undefined);
});

test("readiness requires explicit enabled strings for both capabilities", () => {
  checkCapabilities({
    capabilities: { recording: "enabled", transcription: "enabled" },
  });
  for (const value of [undefined, null, false, true, "disabled", "true"]) {
    assert.throws(
      () =>
        checkCapabilities({
          capabilities: { recording: value, transcription: "enabled" },
        }),
      /Recording/,
    );
    assert.throws(
      () =>
        checkCapabilities({
          capabilities: { recording: "enabled", transcription: value },
        }),
      /Transcription/,
    );
  }
  assert.throws(() => checkCapabilities({}), /Recording/);
});

test("a redacted API credential fails before readiness or any resource creation", async () => {
  const fields = {
    CONFIG_SOURCE: "env",
    API_KEY: "[REDACTED]",
    TENANT_ID: "tenant",
    API_URL: "http://127.0.0.1:1",
    WEB_URL: "https://web.example.test",
    PROOF_ORIGIN: "http://127.0.0.1:4567",
    WEBHOOK_SERVICE_URL: "https://catcher.example.test",
    WEBHOOK_ENDPOINT_ID: "hook",
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(fields)) {
    const key = `CHALK_PROOF_${name}`;
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await assert.rejects(loadConfig(), /API key must use the chalk_sk_ namespace/);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

async function publicReason(execute) {
  const { publicFailure } = await import("./runtime.mjs");
  try {
    await execute();
  } catch (error) {
    const output = [];
    publicFailure("smoke", error, (line) => output.push(line));
    return output[0];
  }
  assert.fail("Expected a proof failure");
}
test("public failures expose bounded configuration, capability, assertion and timeout reasons", async () => {
  const { check, waitFor } = await import("./runtime.mjs");
  const cases = [
    ["configuration", () => check(false, "secret configuration detail", "configuration")],
    ["evidence-assertion", () => check(false, "secret assertion detail")],
    ["capability-disabled", () => checkCapabilities({})],
    ["timeout", () => waitFor("secret timeout label", () => false, 0)],
    [
      "unknown",
      () => {
        throw new Error("secret unknown error");
      },
    ],
  ];
  for (const [reason, execute] of cases) assert.equal(await publicReason(execute), `PROOF smoke: failed (${reason})`);
});
test("public API failures allowlist status and code without exposing values", async (t) => {
  const { request } = await import("./runtime.mjs");
  for (const [code, expected] of [
    ["api_key.inactive", "api_key.inactive"],
    ["secret-value\n::warning::injected", "unknown"],
  ]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code, message: "secret message" } }, { status: 409 }));
    assert.equal(await publicReason(() => request({ api_url: "https://example.invalid" }, "DELETE", "/secret-path")), `PROOF smoke: failed (api:409:${expected})`);
  }
});

async function workflowStep(name) {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/real-call-proof.yml", import.meta.url), "utf8");
  return workflow.split(`      - name: ${name}\n`)[1].split("      - name:")[0];
}

test("hosted recording-rejoin IDs fit the ownership cleanup label", async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { runLabel } = await import("./cleanup.mjs");
  const directory = await mkdtemp(join(tmpdir(), "proof-workflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const uuid = join(directory, "uuid");
  const output = join(directory, "output");
  await writeFile(uuid, "01234567-89ab-cdef-0123-456789abcdef\n");
  const step = await workflowStep("Identify invocation");
  const script = step.match(/        run: (.+)/)[1].replace("/proc/sys/kernel/random/uuid", '"$UUID_FILE"');
  const invocation = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { env: { ...process.env, UUID_FILE: uuid, GITHUB_OUTPUT: output }, encoding: "utf8" });
  assert.equal(invocation.status, 0, invocation.stderr);
  const prefix = (await readFile(output, "utf8")).trim().split("=")[1];
  const assignment = (await workflowStep("Prove a real call")).match(/^\s*run_id=(.+)$/m)[0];
  const id = spawnSync("bash", ["-e", "-c", `${assignment}\nprintf '%s' "$run_id"`], { env: { ...process.env, RUN_PREFIX: prefix, proof: "recording-rejoin" }, encoding: "utf8" });
  assert.equal(id.status, 0, id.stderr);
  assert.doesNotThrow(() => runLabel(id.stdout));
});

test("hosted empty proof lists fail with a bounded configuration reason", async () => {
  const { spawnSync } = await import("node:child_process");
  const step = await workflowStep("Prove a real call");
  const validation = step
    .split("        run: |\n")[1]
    .split("          mkdir -p .private")[0]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", validation], { env: { ...process.env, PROOFS: "   " }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "PROOF configuration: failed (empty-proof-list)");
});
