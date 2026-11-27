import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapInputsMatchCheckpoint, validateBootstrapResources, type BootstrapResourceRow } from "./bootstrap-renderer.ts";

const types: Record<string, string> = {
  ExecutionRole: "AWS.IAM.Role",
  Logs: "AWS.Logs.LogGroup",
  FailureLogMetric: "AWS.Logs.MetricFilter",
  Function: "Chalk.Lambda.VersionedFunction",
  Errors: "AWS.CloudWatch.Alarm",
  Throttles: "AWS.CloudWatch.Alarm",
  AsyncEventsDropped: "AWS.CloudWatch.Alarm",
};
const rows = (actions: Record<string, string>): BootstrapResourceRow[] => Object.entries(types).map(([resource, type]) => ({ action: actions[resource] ?? "create", resource: { FQN: resource, Type: type } }));

test("fresh production bootstrap is complete and create-only", () => {
  assert.doesNotThrow(() => validateBootstrapResources(rows({}), false));
  for (const action of ["noop", "update", "replace", "delete", "adopted"]) {
    assert.throws(() => validateBootstrapResources(rows({ Function: action }), false), /create-only/);
  }
});

test("an interrupted bootstrap resumes after its first checkpoint", () => {
  const interrupted = rows({ ExecutionRole: "noop", Logs: "update", Function: "create" });
  assert.doesNotThrow(() => validateBootstrapResources(interrupted, true));
  for (const action of ["replace", "delete", "adopted"]) {
    assert.throws(() => validateBootstrapResources(rows({ Function: action }), true), /resume/);
  }
});

test("bootstrap still requires the full renderer resource set", () => {
  assert.throws(() => validateBootstrapResources(rows({}).slice(1), true), /resource set/);
  const extra = [...rows({}), { action: "create", resource: { FQN: "Unexpected", Type: "AWS.IAM.Role" } }];
  assert.throws(() => validateBootstrapResources(extra, true), /resource set/);
});

test("interrupted bootstrap inputs must match the saved function checkpoint", () => {
  const input = {
    release_id: "release-a",
    release_manifest_digest: "sha256:manifest-a",
    config_digest: "sha256:config-a",
    artifact_s3_bucket: "bucket-a",
    artifact_s3_key: "key-a",
    artifact_s3_object_version: "version-a",
    artifact_sha256_base64: "sha-a",
  };
  const props = {
    tags: { chalk_release_id: "release-a", chalk_release_manifest_digest: "sha256:manifest-a", chalk_config_digest: "sha256:config-a" },
    code: { bucket: "bucket-a", key: "key-a", version: "version-a", sha256: "sha-a" },
  };
  for (const status of ["creating", "created", "updating", "updated"]) {
    const checkpoint = [{ resource: { FQN: "Function", Type: "Chalk.Lambda.VersionedFunction" }, state: { status, props } }];
    assert.equal(bootstrapInputsMatchCheckpoint(checkpoint, input), true, status);
    assert.equal(bootstrapInputsMatchCheckpoint(checkpoint, { ...input, release_id: "release-b" }), false, `${status} release`);
    assert.equal(bootstrapInputsMatchCheckpoint(checkpoint, { ...input, artifact_s3_key: "key-b" }), false, `${status} key`);
    assert.equal(bootstrapInputsMatchCheckpoint(checkpoint, { ...input, artifact_s3_object_version: "version-b" }), false, `${status} version`);
  }
});

test("a created function checkpoint without stack output still pins the bootstrap release", () => {
  const checkpoint = [
    {
      resource: { FQN: "Function", Type: "Chalk.Lambda.VersionedFunction" },
      state: {
        status: "created",
        props: {
          tags: { chalk_release_id: "release-a", chalk_release_manifest_digest: "sha256:manifest-a", chalk_config_digest: "sha256:config-a" },
          code: { bucket: "bucket-a", key: "key-a", version: "version-a", sha256: "sha-a" },
        },
      },
    },
  ];
  assert.equal(
    bootstrapInputsMatchCheckpoint(checkpoint, {
      release_id: "release-b",
      release_manifest_digest: "sha256:manifest-b",
      config_digest: "sha256:config-b",
      artifact_s3_bucket: "bucket-a",
      artifact_s3_key: "document-renderer/release-b/sha-b.zip",
      artifact_s3_object_version: "version-b",
      artifact_sha256_base64: "sha-b",
    }),
    false,
  );
});
