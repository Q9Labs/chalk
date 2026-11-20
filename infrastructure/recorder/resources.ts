import type * as AWS from "@alchemy.run/aws";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import type * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Redacted from "effect/Redacted";
import { canonicalSetJson } from "../providers/aws-bucket-policy.ts";
import { contextKeys, type RecorderConfig } from "./config.ts";

export const recorderControlPorts = "8443-8444";

export const kmsPolicy = (config: Pick<RecorderConfig, "environment" | "control_plane_role_arn" | "legacy_kms_context_key">, accountId: string): string => {
  const condition = (keys: string[]) => ({
    StringEquals: { "kms:EncryptionContext:chalk.environment": config.environment },
    "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": keys },
    Null: Object.fromEntries(keys.map((key) => [`kms:EncryptionContext:${key}`, "false"])),
  });
  const role = config.control_plane_role_arn ?? "";
  return canonicalSetJson(
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "KeyAdministratorsWithoutDataAccess",
          Effect: "Allow",
          Principal: { AWS: `arn:aws:iam::${accountId}:root` },
          Action: [
            "kms:CancelKeyDeletion",
            "kms:CreateAlias",
            "kms:CreateGrant",
            "kms:Describe*",
            "kms:DisableKey",
            "kms:EnableKey",
            "kms:EnableKeyRotation",
            "kms:Get*",
            "kms:List*",
            "kms:PutKeyPolicy",
            "kms:ScheduleKeyDeletion",
            "kms:TagResource",
            "kms:UntagResource",
            "kms:UpdateAlias",
            "kms:UpdateKeyDescription",
          ],
          Resource: "*",
        },
        { Sid: "ControlPlaneGenerateAndDecryptRecordingKeys", Effect: "Allow", Principal: { AWS: role }, Action: ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext"], Resource: "*", Condition: condition(contextKeys) },
        ...(config.legacy_kms_context_key === null
          ? []
          : [
              {
                Sid: "ControlPlaneDecryptLegacyRecordingCiphertext",
                Effect: "Allow",
                Principal: { AWS: role },
                Action: ["kms:Decrypt", "kms:DescribeKey"],
                Resource: "*",
                Condition: condition(["chalk.environment", "chalk.tenant", config.legacy_kms_context_key, "chalk.recording_job", "chalk.bundle_schema"]),
              },
            ]),
        { Sid: "DenyRecordingDataOperationsOutsideControlPlane", Effect: "Deny", Principal: "*", Action: ["kms:Decrypt", "kms:GenerateDataKey*"], Resource: "*", Condition: { ArnNotEquals: { "aws:PrincipalArn": role } } },
      ],
    }),
  );
};

export const keyProps = (config: RecorderConfig, accountId: string): AWS.KMS.Key["Props"] => ({
  description: `Chalk ${config.environment} recorder bundle KEK`,
  deletionWindow: "30 days",
  enableKeyRotation: true,
  policy: kmsPolicy(config, accountId),
  tags: { chalk_environment: config.environment, chalk_purpose: "recorder-bundle-envelope-encryption", chalk_release: config.release_id },
});

export const poolFirewallProps = (config: Pick<RecorderConfig, "environment" | "control_addresses">, role: "capture" | "render"): DigitalOcean.FirewallProps => {
  const all = ["0.0.0.0/0", "::/0"];
  const outboundRules: DigitalOcean.FirewallRule[] = [
    ...(config.control_addresses.length ? [{ protocol: "tcp", ports: recorderControlPorts, addresses: [...config.control_addresses] } satisfies DigitalOcean.FirewallRule] : []),
    { protocol: "tcp", ports: "443", addresses: all },
    { protocol: "udp", ports: "123", addresses: all },
    { protocol: "udp", ports: "53", addresses: all },
    { protocol: "udp", ports: "3478-65535", addresses: all },
    ...(role === "capture" ? [{ protocol: "udp", ports: "1473", addresses: all } satisfies DigitalOcean.FirewallRule] : []),
  ];
  return { name: `chalk-recorder-${role}-${config.environment}`, dropletIds: [], inboundRules: [], outboundRules };
};

// Provider prop comparison is order-sensitive; Terraform sets and API arrays are not.
export const canonicalBucketProps = (props: Cloudflare.R2.BucketProps): Cloudflare.R2.BucketProps => ({
  ...props,
  ...(props.cors === undefined
    ? {}
    : {
        cors: props.cors
          .map((rule) => ({
            ...rule,
            allowedMethods: [...rule.allowedMethods].sort(),
            allowedOrigins: [...rule.allowedOrigins].sort(),
            ...(rule.allowedHeaders === undefined ? {} : { allowedHeaders: [...rule.allowedHeaders].sort() }),
            ...(rule.exposeHeaders === undefined ? {} : { exposeHeaders: [...rule.exposeHeaders].sort() }),
          }))
          .sort((left, right) => canonicalSetJson(left).localeCompare(canonicalSetJson(right))),
      }),
  ...(props.lifecycleRules === undefined ? {} : { lifecycleRules: [...props.lifecycleRules].sort((left, right) => left.id.localeCompare(right.id)) }),
});

export const bucketProps = (config: RecorderConfig): Cloudflare.R2.BucketProps =>
  canonicalBucketProps({
    name: config.bucket_name,
    locationHint: "apac",
    publicAccess: false,
    domains: [],
    lifecycleRules: [
      { id: "encrypted-temporary-bundles-expire", enabled: true, prefix: config.temporary_bundle_prefix, deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } } },
      { id: config.multipart_abort_rule_id, enabled: true, prefix: "", abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } } },
    ],
    cors: [
      ...config.preserved_bucket_cors_rules.map((rule) => ({
        ...(rule.id === undefined ? {} : { id: rule.id }),
        allowedOrigins: [...rule.allowed.origins],
        allowedMethods: [...rule.allowed.methods],
        ...(rule.allowed.headers === undefined ? {} : { allowedHeaders: [...rule.allowed.headers] }),
        ...(rule.expose_headers === undefined ? {} : { exposeHeaders: [...rule.expose_headers] }),
        ...(rule.max_age_seconds === undefined ? {} : { maxAgeSeconds: rule.max_age_seconds }),
      })),
      {
        id: config.whiteboard_cors_rule_id,
        allowedOrigins: ["*"],
        allowedMethods: ["GET", "PUT"],
        allowedHeaders: ["Content-Type", "If-None-Match", "x-amz-checksum-sha256", "x-amz-meta-chalk-attachment-id", "x-amz-meta-chalk-upload-id", "x-amz-meta-chalk-sha256"],
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3600,
      },
    ],
  });

type Capacity = Pick<RecorderConfig, "desired_capture_nodes" | "desired_render_nodes" | "global_recorder_compute_nodes" | "bucket_name">;
type Owned = { readonly keyArn: string; readonly captureFirewallId: string; readonly renderFirewallId: string };
// The seed writes the same output a deploy writes, so both build it here. Empty
// Droplet lists confer no runtime ownership: the external reconciler owns hosts.
export const stackOutput = (capacity: Capacity, owned: Owned | undefined) => ({
  desired_capture_nodes: capacity.desired_capture_nodes,
  desired_render_nodes: capacity.desired_render_nodes,
  global_recorder_compute_nodes: capacity.global_recorder_compute_nodes,
  recording_bucket_name: capacity.bucket_name,
  recording_kms_key_arn: owned ? Redacted.make(owned.keyArn) : null,
  capture: { droplet_ids: [], droplet_names: [], firewall_id: owned?.captureFirewallId ?? null },
  render: { droplet_ids: [], droplet_names: [], firewall_id: owned?.renderFirewallId ?? null },
});
