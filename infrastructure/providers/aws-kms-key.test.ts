import assert from "node:assert/strict";
import { test } from "node:test";
import * as AWS from "@alchemy.run/aws";
import { KeyProvider } from "@alchemy.run/aws/KMS/Key";
import { flociDual } from "@alchemy.run/aws/Local/FlociServices";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import { stampedMode } from "alchemy/ProviderMode";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { kmsPolicy } from "../recorder/resources.ts";
import { canonicalSetJson } from "./aws-bucket-policy.ts";
import { keepRecordedPolicy, kmsKeyProvider } from "./aws-kms-key.ts";

const policy = (condition: object, actions: string[] = ["kms:Decrypt", "kms:DescribeKey"]) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "A", Effect: "Allow", Action: actions, Condition: condition }] });

test("a policy KMS reordered keeps the recorded text, so drift stays quiet", () => {
  const recorded = policy({ Null: { a: "false", b: "false" }, StringEquals: { c: "x" } });
  const live = { keyId: "k", policy: policy({ StringEquals: { c: "x" }, Null: { b: "false", a: "false" } }, ["kms:DescribeKey", "kms:Decrypt"]) };
  assert.deepEqual(keepRecordedPolicy(live, recorded), { keyId: "k", policy: recorded });
});

test("a policy that changed in meaning is still drift", () => {
  const recorded = policy({ StringEquals: { c: "x" } });
  const live = { keyId: "k", policy: policy({ StringEquals: { c: "y" } }) };
  assert.equal(keepRecordedPolicy(live, recorded), live);
  assert.equal(keepRecordedPolicy(live, undefined), live);
  assert.equal(keepRecordedPolicy(undefined, recorded), undefined);
});

// The recorder's RecordingKey policy as the stack records it (kmsPolicy, sanitized ids), and the same policy
// as KMS returns it: Statement fields, Actions and Condition keys in KMS's own order.
const config: Parameters<typeof kmsPolicy>[0] = { environment: "production", control_plane_role_arn: "arn:aws:iam::123456789012:role/chalk-production-meeting-node", legacy_kms_context_key: null };
const recorded = kmsPolicy(config, "123456789012");
const encryptionContextKeys = ["chalk.environment", "chalk.tenant", "chalk.episode", "chalk.recording", "chalk.recording_job", "chalk.bundle_schema", "chalk.capture_epoch", "chalk.envelope_digest"];
const kmsOrder = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "KeyAdministratorsWithoutDataAccess",
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam::123456789012:root" },
      Action: [
        "kms:UpdateKeyDescription",
        "kms:UpdateAlias",
        "kms:UntagResource",
        "kms:TagResource",
        "kms:ScheduleKeyDeletion",
        "kms:PutKeyPolicy",
        "kms:List*",
        "kms:Get*",
        "kms:EnableKeyRotation",
        "kms:EnableKey",
        "kms:DisableKey",
        "kms:Describe*",
        "kms:CreateGrant",
        "kms:CreateAlias",
        "kms:CancelKeyDeletion",
      ],
      Resource: "*",
    },
    {
      Sid: "ControlPlaneGenerateAndDecryptRecordingKeys",
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam::123456789012:role/chalk-production-meeting-node" },
      Action: ["kms:GenerateDataKeyWithoutPlaintext", "kms:GenerateDataKey", "kms:DescribeKey", "kms:Decrypt"],
      Resource: "*",
      Condition: {
        StringEquals: { "kms:EncryptionContext:chalk.environment": "production" },
        Null: Object.fromEntries([...encryptionContextKeys].reverse().map((key) => [`kms:EncryptionContext:${key}`, "false"])),
        "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": encryptionContextKeys },
      },
    },
    {
      Sid: "DenyRecordingDataOperationsOutsideControlPlane",
      Effect: "Deny",
      Principal: "*",
      Action: ["kms:GenerateDataKey*", "kms:Decrypt"],
      Resource: "*",
      Condition: { ArnNotEquals: { "aws:PrincipalArn": "arn:aws:iam::123456789012:role/chalk-production-meeting-node" } },
    },
  ],
});

const keyId = "00000000-0000-4000-8000-000000000000";
const keyArn = `arn:aws:kms:ap-southeast-1:123456789012:key/${keyId}`;
const output: AWS.KMS.Key["Attributes"] = {
  keyId,
  keyArn,
  keyUsage: "ENCRYPT_DECRYPT",
  keySpec: "SYMMETRIC_DEFAULT",
  enabled: true,
  multiRegion: false,
  deletionWindowInDays: 30,
  tags: {},
  policy: recorded,
  description: undefined,
  keyState: undefined,
  keyRotationEnabled: undefined,
  rotationPeriodInDays: undefined,
};

// KMS over a fake HTTP boundary, behind the registration the stack gets from @alchemy.run/aws: a flociDual
// dispatcher (modes, no read) inside the AWS provider collection.
type Request = Parameters<typeof HttpClientResponse.fromWeb>[0];
const respond = (request: Request, payload: object) => HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } }));
const kms = (livePolicy: string) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      switch (request.headers["x-amz-target"]) {
        case "TrentService.DescribeKey":
          return respond(request, { KeyMetadata: { KeyId: keyId, Arn: keyArn, Enabled: true, KeyManager: "CUSTOMER", KeyUsage: "ENCRYPT_DECRYPT", KeySpec: "SYMMETRIC_DEFAULT", KeyState: "Enabled", MultiRegion: false } });
        case "TrentService.GetKeyPolicy":
          return respond(request, { Policy: livePolicy });
        case "TrentService.GetKeyRotationStatus":
          return respond(request, { KeyRotationEnabled: true });
        default:
          return respond(request, { Tags: [] });
      }
    }),
  );
const registry = (livePolicy: string, wrapped: boolean) => {
  const clients = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, kms(livePolicy)),
    Layer.succeed(Region, Effect.succeed("ap-southeast-1")),
    Layer.succeed(Endpoint, Effect.undefined),
    Credentials.fromCredentials({ accessKeyId: Redacted.make("test"), secretAccessKey: Redacted.make("test") }, "ap-southeast-1"),
  );
  const engine = Layer.mergeAll(clients, Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy", dev: false, adopt: false }), Layer.succeed(Stage, "production"), Layer.succeed(Stack, { name: "recorder", stage: "production", resources: {}, bindings: {}, actions: {} }));
  const dual = flociDual(AWS.KMS.Key, () => KeyProvider()).pipe(Layer.provideMerge(engine));
  // The same wiring as recorder/alchemy.run.ts: the wrapper is registered next to the upstream registration.
  return wrapped ? Layer.mergeAll(dual, kmsKeyProvider.pipe(Layer.provide(dual))) : dual;
};

// Drift resolves the provider of a persisted row with findProviderByType and the row's stamped mode, then reads.
const driftRead = (livePolicy: string, wrapped: boolean) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.findProviderByType<AWS.KMS.Key>(AWS.KMS.Key.Type, stampedMode({ attr: output }));
      assert.ok(provider.read, "the provider Drift resolves can read");
      return yield* provider.read({ id: "RecordingKey", fqn: "RecordingKey", instanceId: "i", olds: {}, output });
    }).pipe(Effect.provide(registry(livePolicy, wrapped))),
  );

test("Drift's registered KMS.Key provider keeps the recorded policy when KMS reorders it", async () => {
  assert.notEqual(kmsOrder, recorded);
  assert.equal(canonicalSetJson(kmsOrder), canonicalSetJson(recorded));
  assert.equal((await driftRead(kmsOrder, true))?.policy, recorded);
});

test("Drift's registered KMS.Key provider still reports a policy that changed in meaning", async () => {
  const widened = kmsOrder.replace("kms:Decrypt", "kms:ReEncrypt*");
  assert.equal((await driftRead(widened, true))?.policy, widened);
});

// Control: without the wrapper the same registration reports KMS's reordered text, which is the upstream bug
// (alchemy-run/alchemy#3531). When this test fails, upstream is fixed and the wrapper can be deleted.
test("without the wrapper, the registered KMS.Key provider surfaces KMS's reordered policy as drift", async () => {
  assert.equal((await driftRead(kmsOrder, false))?.policy, kmsOrder);
});
