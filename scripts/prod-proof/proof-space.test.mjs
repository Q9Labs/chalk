import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createSpace } from "./proofs.mjs";

// The public API refuses a Create Space request that names the own SFU, so a proof names no
// plane and fails at once when the Space it gets is not on the plane it asked for.
async function fakeRun(responder) {
  const requests = [];
  return {
    requests,
    directory: await mkdtemp(`${tmpdir()}/proof-space-`),
    runId: "run",
    label: "label",
    tenantPath: "/v1/tenants/t",
    apiRequest: async (method, path, body) => {
      requests.push({ method, path, body });
      return responder(method, body);
    },
  };
}

const policyApplied = { recording_policy: "manual", transcription_policy: "on_demand" };

test("a proof Space is created without naming a plane and must be on the requested one", async () => {
  const run = await fakeRun(() => ({ id: "s", effective_media_plane: "chalk_sfu", media_plane: "cf_sfu", ...policyApplied }));
  const space = await createSpace(run, "chalk_sfu");
  assert.equal(space.id, "s");
  assert.equal("media_plane" in run.requests[0].body, false);
});

test("a Space on another plane stops the run with media-plane-config", async () => {
  const run = await fakeRun(() => ({ id: "s", effective_media_plane: "cf_sfu", media_plane: "cf_sfu", ...policyApplied }));
  await assert.rejects(createSpace(run, "chalk_sfu"), (error) => error.reason === "media-plane-config" && /not chalk_sfu/.test(error.message));
});

test("an operator-moved Space is reused for its plane and checked the same way", async () => {
  process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU = "pinned";
  try {
    const run = await fakeRun((method) => ({ id: "pinned", effective_media_plane: method === "GET" ? "cf_sfu" : "chalk_sfu" }));
    await assert.rejects(createSpace(run, "chalk_sfu"), (error) => error.reason === "media-plane-config");
    assert.deepEqual(
      run.requests.map((request) => request.method),
      ["GET"],
    );
  } finally {
    delete process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU;
  }
});
