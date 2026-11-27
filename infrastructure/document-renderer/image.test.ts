import assert from "node:assert/strict";
import { test } from "node:test";
import { imageUri, isImageInputs, parseInputs } from "./config.ts";
import { buildEnvironment } from "./environment.ts";
import { rendererPolicy } from "./policy.ts";
import { resourceProps } from "./resources.ts";
import { bootstrapInputsMatchCheckpoint } from "../releases/bootstrap-renderer.ts";
import { requireRunOwnedFunction } from "../providers/aws-versioned-function.ts";
import { selectStack } from "../registry.ts";

const repository = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/chalk-document-renderer";
const image = {
  function_name: "chalk-nightly-test-document-renderer-image",
  environment_name: "nightly-test",
  package_type: "image",
  release_id: "release-test-01",
  release_manifest_digest: `sha256:${"ab".repeat(32)}`,
  config_digest: `sha256:${"cd".repeat(32)}`,
  image_repository_uri: repository,
  image_digest: `sha256:${"ef".repeat(32)}`,
  timeout_seconds: 300,
  reserved_concurrency: 4,
  memory_size: 3072,
  ephemeral_storage_size: 2048,
  control_api_url: "https://api.example.test",
  log_retention_days: 30,
  log_kms_key_arn: null,
  failure_queue_kms_key_arn: null,
  async_max_event_age_seconds: 3600,
  async_maximum_retry_attempts: 1,
  alarm_actions: [],
  control_api_invoker_principal: null,
  control_api_invoke_source_arn: null,
  control_api_invoker_role_name: null,
};

test("image renderer deploys the digest-pinned image with no runtime or handler", () => {
  const input = parseInputs(image);
  assert.ok(isImageInputs(input));
  const props = resourceProps(input, "123456789012", "ap-southeast-1");
  assert.deepEqual(props.fn.code, { imageUri: `${repository}@sha256:${"ef".repeat(32)}` });
  assert.equal(props.fn.runtime, undefined);
  assert.equal(props.fn.handler, undefined);
  assert.deepEqual(props.fn.architectures, ["arm64"]);
  assert.equal(props.fn.memorySize, 3072);
  assert.equal(props.fn.ephemeralStorageSize, 2048);
  assert.ok(!("artifact_identity" in props.outputs));
  assert.deepEqual("image_identity" in props.outputs ? props.outputs.image_identity : undefined, { repository, digest: input.image_digest });
  assert.equal(buildEnvironment(input).LD_LIBRARY_PATH, "/opt/renderer/lib");
  assert.equal(imageUri(input), props.fn.code && "imageUri" in props.fn.code ? props.fn.code.imageUri : "");
});

test("image renderer keeps its own function, role, log group and alarm names", () => {
  const { image_repository_uri: _repository, image_digest: _digest, ...common } = image;
  const zip = parseInputs({
    ...common,
    package_type: "zip",
    function_name: "chalk-nightly-test-document-renderer",
    artifact_s3_bucket: "test-artifacts",
    artifact_s3_key: "document-renderer/release-test-01/renderer.zip",
    artifact_s3_object_version: "v1",
    artifact_sha256: "ab".repeat(32),
    artifact_sha256_base64: Buffer.from("ab".repeat(32), "hex").toString("base64"),
  });
  const names = (props: ReturnType<typeof resourceProps>) => [props.fn.functionName, props.executionRole.roleName, props.log.logGroupName, ...Object.values(props.alarms).map((alarm) => alarm.name)];
  const imageNames = names(resourceProps(parseInputs(image), "123456789012", "ap-southeast-1"));
  for (const name of names(resourceProps(zip, "123456789012", "ap-southeast-1"))) assert.ok(!imageNames.includes(name));
});

const invalid = [
  { memory_size: 2048 },
  { image_digest: "latest" },
  { image_repository_uri: `${repository}:latest` },
  { image_repository_uri: "ghcr.io/q9labs/renderer" },
  { function_name: "chalk-nightly-test-document-renderer" },
  { function_name: "chalk-other-document-renderer-image" },
  { artifact_s3_bucket: "test-artifacts" },
];
for (const update of invalid) {
  test(`invalid image renderer input is rejected: ${Object.keys(update).join(",")}`, () => assert.throws(() => parseInputs({ ...image, ...update })));
}

test("a ZIP function name cannot carry image inputs and an image name cannot carry a ZIP", () => {
  assert.throws(() => parseInputs({ ...image, function_name: "chalk-nightly-test-document-renderer" }));
});

test("image release policy edits only the image and release identity", () => {
  const input = parseInputs(image);
  const { policy } = rendererPolicy({ resources: [], outputs: { before: {}, after: {} } }, input, "release");
  const edits = policy.resources.find((resource) => resource.id === "Function")?.patches.map((patch) => patch.path.join(".")) ?? [];
  assert.ok(edits.includes("code.imageUri"));
  assert.ok(!edits.some((path) => path === "code.key" || path === "code.version" || path === "code.sha256"));
  assert.deepEqual(policy.outputs, ["image_identity", "release_identity"]);
  assert.ok(policy.inputs.includes("image_digest") && !policy.inputs.includes("artifact_s3_key"));
});

test("only run-scoped ephemeral stages and the approved production bootstrap may create the image function", () => {
  assert.doesNotThrow(() => requireRunOwnedFunction("nightly-run-1", "chalk-nightly-run-1-document-renderer-image"));
  assert.throws(() => requireRunOwnedFunction("production", "chalk-production-document-renderer-image"));
  assert.throws(() => requireRunOwnedFunction("nightly-run-1", "chalk-nightly-run-2-document-renderer-image"));
  process.env.CHALK_DOCUMENT_RENDERER_PRODUCTION_BOOTSTRAP = "approved";
  try {
    assert.doesNotThrow(() => requireRunOwnedFunction("production", "chalk-production-document-renderer-image"));
    assert.throws(() => requireRunOwnedFunction("production", "chalk-production-document-renderer-image", "delete"));
  } finally {
    delete process.env.CHALK_DOCUMENT_RENDERER_PRODUCTION_BOOTSTRAP;
  }
});

test("the image stack is registered for ephemeral proofs and a seeded production stage", () => {
  assert.equal(selectStack("document-renderer-image", "production").target.directory, "document-renderer-image");
  assert.equal(selectStack("document-renderer-image", "nightly-run-1").target.stackName, "document-renderer-image");
});

test("an interrupted image bootstrap resumes only with the same digest", () => {
  const checkpoint = [
    {
      resource: { FQN: "Function" },
      state: {
        status: "creating",
        props: {
          tags: { chalk_release_id: image.release_id, chalk_release_manifest_digest: image.release_manifest_digest, chalk_config_digest: image.config_digest },
          code: { imageUri: `${repository}@${image.image_digest}` },
        },
      },
    },
  ];
  assert.equal(bootstrapInputsMatchCheckpoint(checkpoint, image), true);
  assert.equal(bootstrapInputsMatchCheckpoint(checkpoint, { ...image, image_digest: `sha256:${"11".repeat(32)}` }), false);
});
