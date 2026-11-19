import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { loadInputs } from "./inputs.ts";
import { credential } from "./credentials.ts";
import { requireDeployable, selectStack } from "../registry.ts";

test("registry rejects persistent Nightly, retired deployments and unseeded production", () => {
  assert.throws(() => selectStack("transcription-dispatcher", "nightly"));
  assert.throws(() => selectStack("recorder-runtime-downloads", "production"), /Unsupported/);
  assert.throws(() => selectStack("recorder-control-endpoint", "nightly-test"), /Unsupported/);
  assert.throws(() => requireDeployable(selectStack("transcription-dispatcher", "production").target), /not cut over and seeded/);
  assert.equal(requireDeployable(selectStack("transcription-dispatcher", "nightly-test").target).stageKind, "ephemeral");
});
test("one input file boundary validates without disclosing private values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-input-test-"));
  const previous = process.env.CHALK_INFRA_INPUTS;
  const file = join(directory, "inputs.json");
  try {
    delete process.env.CHALK_INFRA_INPUTS;
    const parse = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }), { onExcessProperty: "error" });
    await assert.rejects(loadInputs("test", parse), /Set CHALK_INFRA_INPUTS/);
    process.env.CHALK_INFRA_INPUTS = file;
    await writeFile(file, '{"count":1}', { mode: 0o600 });
    assert.deepEqual(await loadInputs("test", parse), { count: 1 });
    await writeFile(file, '{"count":"PRIVATE_SENTINEL"}');
    await assert.rejects(loadInputs("test", parse), { message: "Invalid or unreadable test inputs from CHALK_INFRA_INPUTS; contents are not printed" });
  } finally {
    if (previous === undefined) delete process.env.CHALK_INFRA_INPUTS;
    else process.env.CHALK_INFRA_INPUTS = previous;
    await rm(directory, { recursive: true });
  }
});
test("missing provider credentials name their protected source without values", () => {
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "DIGITALOCEAN_TOKEN", "CHALK_CAPTURE_DIGITALOCEAN_TOKEN", "CHALK_RENDER_DIGITALOCEAN_TOKEN"] as const) {
    const previous = process.env[key];
    try {
      delete process.env[key];
      assert.throws(() => credential(key), { message: `Missing ${key}; inject it from the protected operator/CI environment, not CHALK_INFRA_INPUTS` });
    } finally {
      if (previous !== undefined) process.env[key] = previous;
    }
  }
});
