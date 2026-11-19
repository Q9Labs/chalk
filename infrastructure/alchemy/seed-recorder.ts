import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { poolFirewallProps } from "../recorder/resources.ts";
import { CaptureFirewall, CaptureTag, RenderFirewall, RenderTag } from "./recorder-pools.ts";
import { RecordingBucket } from "./recording-bucket.ts";
import { checkFirewall, firewallProps, tofuFirewall } from "./seed-sfu.ts";
import { expectResources, getResource, lookup, observe, row, semanticJson, type TofuState } from "./tofu-state.ts";

const nullable = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));
const age = Schema.Struct({ condition: nullable(Schema.Union([Schema.Struct({ type: Schema.Literal("Age"), max_age: Schema.Number, date: nullable(Schema.Null) }), Schema.Struct({ type: Schema.Null, max_age: Schema.Null, date: nullable(Schema.Null) })])) });
const corsRule = Schema.Struct({
  id: nullable(Schema.String),
  allowed: Schema.Struct({ origins: Schema.Array(Schema.String), methods: Schema.Array(Schema.Literals(["GET", "PUT", "POST", "DELETE", "HEAD"])), headers: nullable(Schema.Array(Schema.String)) }),
  expose_headers: nullable(Schema.Array(Schema.String)),
  max_age_seconds: nullable(Schema.Number),
});
const lifecycleRule = Schema.Struct({ id: Schema.String, enabled: Schema.Boolean, conditions: Schema.Struct({ prefix: Schema.String }), abort_multipart_uploads_transition: nullable(age), delete_objects_transition: nullable(age), storage_class_transitions: nullable(Schema.Array(Schema.Never)) });
const runtime = Schema.Struct({
  input: Schema.Struct({
    value: Schema.Struct({
      bootstrap_endpoint: Schema.String,
      desired_nodes: Schema.Number,
      immutable_image_digest: Schema.String,
      immutable_image_id: Schema.Number,
      max_nodes: Schema.Number,
      node_size: Schema.String,
      pool: Schema.String,
      region: Schema.String,
      runtime_owner: Schema.Literal("external-recorder-reconciler"),
      gpu: Schema.optional(Schema.Boolean),
    }),
  }),
});

export const seedRecorder = Effect.fn(function* (source: TofuState, stage: string) {
  expectResources(source, [
    "aws_kms_key.recording",
    "aws_kms_alias.recording",
    "cloudflare_r2_bucket.recording",
    "cloudflare_r2_bucket_cors.whiteboard",
    "cloudflare_r2_bucket_lifecycle.recording",
    "terraform_data.apply_gate",
    ...(stage === "production" ? ["terraform_data.production_cutover_gate"] : []),
    ...["capture", "render"].flatMap((role) => [`module.${role}.digitalocean_firewall.${role}`, `module.${role}.digitalocean_tag.pool`, `module.${role}.terraform_data.runtime_capacity_contract`]),
  ]);
  const key = getResource(
    source,
    "aws_kms_key.recording",
    Schema.Struct({
      id: Schema.String,
      arn: Schema.String,
      description: Schema.String,
      deletion_window_in_days: Schema.Literal(30),
      enable_key_rotation: Schema.Literal(true),
      policy: Schema.String,
      tags: Schema.Record(Schema.String, Schema.String),
      is_enabled: Schema.Literal(true),
      key_usage: Schema.Literal("ENCRYPT_DECRYPT"),
      customer_master_key_spec: Schema.Literal("SYMMETRIC_DEFAULT"),
      multi_region: Schema.Literal(false),
      region: Schema.Literal("ap-southeast-1"),
    }),
  );
  const alias = getResource(source, "aws_kms_alias.recording", Schema.Struct({ name: Schema.String, target_key_id: Schema.String }));
  const bucket = getResource(source, "cloudflare_r2_bucket.recording", Schema.Struct({ name: Schema.String, id: Schema.String, account_id: Schema.String, location: Schema.Literal("APAC"), jurisdiction: Schema.Literal("default"), storage_class: Schema.Literal("Standard") }));
  const cors = getResource(source, "cloudflare_r2_bucket_cors.whiteboard", Schema.Struct({ account_id: Schema.String, bucket_name: Schema.String, rules: Schema.Array(corsRule) }));
  const lifecycle = getResource(source, "cloudflare_r2_bucket_lifecycle.recording", Schema.Struct({ account_id: Schema.String, bucket_name: Schema.String, rules: Schema.Array(lifecycleRule) }));
  const applied = getResource(
    source,
    "terraform_data.apply_gate",
    Schema.Struct({ input: Schema.Struct({ value: Schema.Struct({ desired_capture_nodes: Schema.Number, desired_render_nodes: Schema.Number, environment: Schema.String, global_recorder_node_count: Schema.Number, release_id: Schema.String, staging_evidence_digest: Schema.String }) }) }),
  ).input.value;
  if (
    applied.environment !== stage ||
    key.tags.chalk_environment !== stage ||
    applied.release_id !== key.tags.chalk_release ||
    key.description !== `Chalk ${stage} recorder bundle KEK` ||
    alias.name !== `alias/chalk-recorder-${stage}` ||
    alias.target_key_id !== key.id ||
    cors.account_id !== bucket.account_id ||
    lifecycle.account_id !== bucket.account_id ||
    cors.bucket_name !== bucket.name ||
    lifecycle.bucket_name !== bucket.name
  )
    return yield* Effect.die("Recorder state resources do not share the selected stage and identity.");
  if (stage === "production") {
    const cutover = getResource(
      source,
      "terraform_data.production_cutover_gate",
      Schema.Struct({ input: Schema.Struct({ value: Schema.Struct({ capacity_inputs_migrated: Schema.Literal(true), episode_kms_context_cutover_complete: Schema.Boolean, legacy_kms_context_decrypt_policy_active: Schema.Boolean }) }) }),
    ).input.value;
    if (cutover.episode_kms_context_cutover_complete === cutover.legacy_kms_context_decrypt_policy_active) return yield* Effect.die("Invalid production KMS context cutover state.");
  }
  const keyAttr = yield* lookup(AWS.KMS.Key, { keyId: key.id });
  if (keyAttr.keyArn !== key.arn || keyAttr.description !== key.description || !keyAttr.enabled || !keyAttr.keyRotationEnabled || semanticJson(keyAttr.policy ?? "null") !== semanticJson(key.policy) || semanticJson(keyAttr.tags) !== semanticJson(key.tags))
    return yield* Effect.die("Live recorder KMS key differs from tofu state.");
  const aliasAttr = yield* lookup(AWS.KMS.Alias, { aliasName: alias.name });
  if (aliasAttr.targetKeyId !== key.id) return yield* Effect.die("Live KMS alias target differs from state.");
  const rows: CreatedResourceState[] = [
    row(AWS.KMS.Key.Type, "RecordingKey", key.id, { description: key.description, deletionWindow: "30 days", enableKeyRotation: true, policy: semanticJson(key.policy), tags: key.tags } satisfies AWS.KMS.Key["Props"], keyAttr, ["RecordingAlias"], "protect"),
    row(AWS.KMS.Alias.Type, "RecordingAlias", alias.name, { aliasName: aliasAttr.aliasName, targetKeyId: key.id } satisfies AWS.KMS.Alias["Props"], aliasAttr, [], "protect"),
  ];
  const cf = yield* CloudflareEnvironment.current;
  if (cf.accountId !== bucket.account_id) return yield* Effect.die("Cloudflare credential account differs from the source state.");
  const bucketAttr = yield* lookup(Cloudflare.R2.Bucket, { name: bucket.name, jurisdiction: "default" });
  const corsProps: Cloudflare.R2.BucketCorsRule[] = cors.rules.map((rule) => ({
    ...(rule.id == null ? {} : { id: rule.id }),
    allowedOrigins: [...rule.allowed.origins],
    allowedMethods: [...rule.allowed.methods],
    ...(rule.allowed.headers == null ? {} : { allowedHeaders: [...rule.allowed.headers] }),
    ...(rule.expose_headers == null ? {} : { exposeHeaders: [...rule.expose_headers] }),
    ...(rule.max_age_seconds == null ? {} : { maxAgeSeconds: rule.max_age_seconds }),
  }));
  const lifecycleProps: Cloudflare.R2.BucketLifecycleRule[] = lifecycle.rules.map((rule) => ({
    id: rule.id,
    enabled: rule.enabled,
    prefix: rule.conditions.prefix,
    ...(rule.abort_multipart_uploads_transition?.condition?.type !== "Age" ? {} : { abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: rule.abort_multipart_uploads_transition.condition.max_age } } }),
    ...(rule.delete_objects_transition?.condition?.type !== "Age" ? {} : { deleteObjectsTransition: { condition: { type: "Age", maxAge: rule.delete_objects_transition.condition.max_age } } }),
  }));
  const bucketDrift = [
    ...(bucketAttr.bucketName !== bucket.name || bucketAttr.accountId !== bucket.account_id || bucketAttr.location !== "apac" || bucketAttr.storageClass !== bucket.storage_class ? ["identity/location/storage class"] : []),
    ...(bucketAttr.publicDomain !== undefined || bucketAttr.domains.length ? ["public access"] : []),
    ...(semanticJson(bucketAttr.cors) !== semanticJson(corsProps) ? ["CORS"] : []),
    ...(semanticJson(bucketAttr.lifecycleRules) !== semanticJson(lifecycleProps) ? ["lifecycle"] : []),
  ];
  if (bucketDrift.length) return yield* Effect.die(`Live R2 differs from tofu state: ${bucketDrift.join(", ")}; resolve drift before seeding.`);
  rows.push(row(RecordingBucket.Type, "RecordingBucket", bucket.id, { name: bucket.name, locationHint: "apac", publicAccess: false, domains: [], cors: corsProps, lifecycleRules: lifecycleProps } satisfies RecordingBucket["Props"], bucketAttr, [], "protect"));
  let capture = 0;
  const roles: ("capture" | "render")[] = ["capture", "render"];
  for (const role of roles) {
    const contract = getResource(source, `module.${role}.terraform_data.runtime_capacity_contract`, runtime).input.value;
    if (
      !Number.isSafeInteger(contract.desired_nodes) ||
      contract.desired_nodes < 0 ||
      !Number.isSafeInteger(contract.max_nodes) ||
      contract.max_nodes < 1 ||
      contract.desired_nodes > contract.max_nodes ||
      contract.pool !== `chalk-recorder-${role}` ||
      (role === "render" && (contract.desired_nodes !== 0 || contract.max_nodes !== 10))
    )
      return yield* Effect.die("Invalid recorder runtime capacity contract.");
    if (role === "capture") capture = contract.desired_nodes;
    if (contract.desired_nodes !== (role === "capture" ? applied.desired_capture_nodes : applied.desired_render_nodes)) return yield* Effect.die("Recorder runtime contract and apply gate capacity differ.");
    const tag = getResource(source, `module.${role}.digitalocean_tag.pool`, Schema.Struct({ id: Schema.String, name: Schema.String }));
    const fw = getResource(source, `module.${role}.digitalocean_firewall.${role}`, tofuFirewall);
    if (tag.name !== contract.pool || tag.id !== tag.name || fw.name !== `chalk-recorder-${role}-${stage}` || fw.droplet_ids.length || fw.inbound_rule.length || fw.tags?.length) return yield* Effect.die("Recorder policies must remain outbound-only, unattached and correctly named.");
    const sourceProps = firewallProps(fw);
    const props = poolFirewallProps({ environment: Schema.decodeUnknownSync(Schema.Literals(["nightly", "production"]))(stage), control_addresses: fw.outbound_rule.find((rule) => rule.protocol === "tcp" && rule.port_range === "8443-8444")?.destination_addresses ?? [] }, role);
    const fwResource = role === "capture" ? CaptureFirewall : RenderFirewall;
    const tagResource = role === "capture" ? CaptureTag : RenderTag;
    const fwAttr = yield* role === "capture" ? observe(CaptureFirewall, props, "CaptureFirewall") : observe(RenderFirewall, props, "RenderFirewall");
    const tagAttr = yield* role === "capture" ? observe(CaptureTag, { name: tag.name }, "CaptureTag") : observe(RenderTag, { name: tag.name }, "RenderTag");
    if (fwAttr.firewallId !== fw.id || tagAttr.name !== tag.name) return yield* Effect.die("Recorder DigitalOcean resource identity differs from state.");
    checkFirewall(sourceProps, fwAttr);
    checkFirewall(props, fwAttr);
    rows.push(row(fwResource.Type, role === "capture" ? "CaptureFirewall" : "RenderFirewall", fw.id, props, fwAttr, [], "protect"), row(tagResource.Type, role === "capture" ? "CaptureTag" : "RenderTag", tag.id, { name: tag.name }, tagAttr, [], "protect"));
  }
  if (applied.global_recorder_node_count !== capture + applied.desired_render_nodes || applied.global_recorder_node_count > 20) return yield* Effect.die("Recorder compute demand exceeds or disagrees with the global contract.");
  return rows;
});
