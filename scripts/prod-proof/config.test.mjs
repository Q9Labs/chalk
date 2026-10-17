import assert from "node:assert/strict";
import test from "node:test";
import { checkCapabilities, environmentConfig } from "./runtime.mjs";

test("environment configuration maps each named field without interpreting credentials", () => {
  const fields = {
    api_key: "quotes'=$keep",
    tenant_id: "tenant",
    api_url: "https://api.example.test",
    web_url: "https://web.example.test",
    proof_origin: "http://127.0.0.1:4567",
    webhook_service_url: "https://catcher.example.test",
  };
  const environment = Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [
      `CHALK_PROOF_${name.toUpperCase()}`,
      value,
    ]),
  );
  assert.deepEqual(
    environmentConfig({ ...environment, PASSWORD: "unrelated" }),
    fields,
  );
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
