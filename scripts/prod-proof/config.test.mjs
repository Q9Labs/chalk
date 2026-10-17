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
