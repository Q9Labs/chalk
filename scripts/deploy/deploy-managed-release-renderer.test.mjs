import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { rendererBinding, rendererImageBinding } from "./deploy-managed-release.mjs";

test("renderer binding does not depend on dispatcher configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renderer-binding-"));
  try {
    await writeFile(join(directory, "release.json"), "{}");
    await writeFile(join(directory, "release.media.json"), "{}");
    const calls = [];
    process.env.CHALK_RENDERER_RELEASE_ENABLED = "true";
    const result = await rendererBinding({
      commandRunner: async (command) => {
        calls.push(command);
        return { stdout: JSON.stringify({ action: "renderer-not-bootstrapped", verified: false }) };
      },
      options: { manifestPath: join(directory, "release.json"), environment: "production", region: "ap-southeast-1" },
      dryRun: true,
    });
    assert.equal(result.action, "renderer-not-bootstrapped");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.includes("--config-parameter"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renderer binding never invokes state reads for a Nightly renderer sidecar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renderer-binding-nightly-"));
  try {
    await writeFile(join(directory, "release.json"), "{}");
    await writeFile(join(directory, "release.media.json"), JSON.stringify({ renderer: { bucket: "artifact", key: "renderer.zip", version_id: "version", sha256: "0".repeat(64) } }));
    const result = await rendererBinding({
      commandRunner: async () => {
        throw new Error("Nightly must not invoke renderer state preflight");
      },
      options: { manifestPath: join(directory, "release.json"), environment: "nightly", region: "ap-southeast-1" },
      dryRun: true,
    });
    assert.equal(result.action, "renderer-not-production-target");
    assert.equal(result.left_live, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production renderer binding is skipped until bootstrap is explicitly declared", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renderer-binding-undeclared-"));
  try {
    await writeFile(join(directory, "release.json"), "{}");
    await writeFile(join(directory, "release.media.json"), "{}");
    delete process.env.CHALK_RENDERER_RELEASE_ENABLED;
    const result = await rendererBinding({
      commandRunner: async () => {
        throw new Error("an undeclared renderer must not invoke renderer state preflight");
      },
      options: { manifestPath: join(directory, "release.json"), environment: "production", region: "ap-southeast-1" },
      dryRun: true,
    });
    assert.equal(result.action, "renderer-not-declared");
    assert.equal(result.left_live, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renderer image binding is skipped until its own declaration, whatever the ZIP declaration says", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renderer-image-binding-"));
  try {
    await writeFile(join(directory, "release.json"), "{}");
    await writeFile(join(directory, "release.media.json"), "{}");
    process.env.CHALK_RENDERER_RELEASE_ENABLED = "true";
    delete process.env.CHALK_RENDERER_IMAGE_RELEASE_ENABLED;
    const options = { manifestPath: join(directory, "release.json"), environment: "production", region: "ap-southeast-1" };
    const commandRunner = async () => {
      throw new Error("an undeclared renderer image must not invoke state preflight");
    };
    assert.equal((await rendererImageBinding({ commandRunner, options, dryRun: true })).action, "renderer-image-not-declared");
    assert.equal((await rendererImageBinding({ commandRunner, options: { ...options, environment: "nightly" }, dryRun: true })).action, "renderer-image-not-production-target");
    process.env.CHALK_RENDERER_IMAGE_RELEASE_ENABLED = "true";
    const calls = [];
    const result = await rendererImageBinding({
      commandRunner: async ({ args }) => {
        calls.push(args);
        return { stdout: JSON.stringify({ action: "renderer-image-not-bootstrapped", verified: false }) };
      },
      options,
      dryRun: true,
    });
    assert.equal(result.action, "renderer-image-not-bootstrapped");
    assert.ok(calls[0].includes("deploy_renderer_image") && calls[0].includes("--dry-run"));
  } finally {
    delete process.env.CHALK_RENDERER_RELEASE_ENABLED;
    delete process.env.CHALK_RENDERER_IMAGE_RELEASE_ENABLED;
    await rm(directory, { recursive: true, force: true });
  }
});
