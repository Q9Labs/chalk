import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { cidr } from "../sfu/config.ts";

const corsRules = Schema.Array(
  Schema.Struct({
    id: Schema.optional(Schema.String),
    allowed: Schema.Struct({ origins: Schema.Array(Schema.String), methods: Schema.Array(Schema.Literals(["GET", "PUT", "POST", "DELETE", "HEAD"])), headers: Schema.optional(Schema.Array(Schema.String)) }),
    expose_headers: Schema.optional(Schema.Array(Schema.String)),
    max_age_seconds: Schema.optional(Schema.Number),
  }),
);
const schema = Schema.Struct({
  environment: Schema.optional(Schema.Literals(["nightly", "production"])),
  enable_apply: Schema.optional(Schema.Boolean),
  staging_evidence_digest: Schema.optional(Schema.NullOr(Schema.String)),
  capture_region: Schema.optional(Schema.String),
  control_addresses: Schema.optional(Schema.Array(Schema.String)),
  cloudflare_account_id: Schema.optional(Schema.NullOr(Schema.String)),
  recording_bucket_name: Schema.optional(Schema.NullOr(Schema.String)),
  recording_bucket_import_id: Schema.optional(Schema.NullOr(Schema.String)),
  recording_bucket_adoption_plan_digest: Schema.optional(Schema.NullOr(Schema.String)),
  preserved_bucket_cors_rules: Schema.optional(corsRules),
  whiteboard_cors_rule_id: Schema.optional(Schema.String),
  multipart_abort_rule_id: Schema.optional(Schema.String),
  temporary_bundle_prefix: Schema.optional(Schema.String),
  kms_region: Schema.optional(Schema.String),
  control_plane_role_arn: Schema.optional(Schema.NullOr(Schema.String)),
  legacy_kms_context_key: Schema.optional(Schema.NullOr(Schema.String)),
  episode_kms_context_cutover_complete: Schema.optional(Schema.Boolean),
  capture_image_id: Schema.optional(Schema.Number),
  capture_image_digest: Schema.optional(Schema.NullOr(Schema.String)),
  render_image_id: Schema.optional(Schema.Number),
  render_image_digest: Schema.optional(Schema.NullOr(Schema.String)),
  release_id: Schema.optional(Schema.String),
  capture_bootstrap_endpoint: Schema.optional(Schema.NullOr(Schema.String)),
  render_bootstrap_endpoint: Schema.optional(Schema.NullOr(Schema.String)),
  reserved_capture_episodes: Schema.optional(Schema.Number),
  reserved_capture_participants: Schema.optional(Schema.Number),
  reserved_capture_input_mbps: Schema.optional(Schema.Number),
  ready_spare: Schema.optional(Schema.Number),
  capture_max_nodes: Schema.optional(Schema.Number),
  capture_episodes_per_node: Schema.optional(Schema.Number),
  capture_capacity_inputs_migrated: Schema.optional(Schema.Boolean),
  capture_participants_per_node: Schema.optional(Schema.Number),
  capture_input_mbps_per_node: Schema.optional(Schema.Number),
  render_desired_nodes: Schema.optional(Schema.Number),
  capture_node_size: Schema.optional(Schema.String),
  capture_profile_evidence_sha256: Schema.optional(Schema.NullOr(Schema.String)),
  render_node_size: Schema.optional(Schema.String),
  render_region: Schema.optional(Schema.String),
  render_gpu: Schema.optional(Schema.Boolean),
});
export const requireInput = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};
const digest = (value: string | null): boolean => value === null || /^sha256:[a-f0-9]{64}$/.test(value);
const integer = (value: number, min: number, max = Number.MAX_SAFE_INTEGER): boolean => Number.isSafeInteger(value) && value >= min && value <= max;
export const contextKeys = ["chalk.environment", "chalk.tenant", "chalk.episode", "chalk.recording", "chalk.recording_job", "chalk.bundle_schema", "chalk.capture_epoch", "chalk.envelope_digest"];

export const parseRecorderConfig = (value: unknown) => {
  // Secrets come from environment/credential providers, never the JSON inputs.
  const input = (() => {
    try {
      return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
    } catch {
      throw new Error("Invalid recorder input types, unknown fields or embedded credentials; input contents are not printed.");
    }
  })();
  const identityAndBucketDefaults = () => ({
    environment: input.environment ?? "nightly",
    enable_apply: input.enable_apply ?? false,
    staging_evidence_digest: input.staging_evidence_digest ?? null,
    capture_region: input.capture_region ?? "blr1",
    control_addresses: input.control_addresses ?? [],
    cloudflare_account_id: input.cloudflare_account_id ?? null,
    recording_bucket_name: input.recording_bucket_name ?? null,
    recording_bucket_import_id: input.recording_bucket_import_id ?? null,
    recording_bucket_adoption_plan_digest: input.recording_bucket_adoption_plan_digest ?? null,
    preserved_bucket_cors_rules: input.preserved_bucket_cors_rules ?? [],
  });
  const encryptionAndImageDefaults = () => ({
    whiteboard_cors_rule_id: input.whiteboard_cors_rule_id ?? "whiteboard-v1-browser-files",
    multipart_abort_rule_id: input.multipart_abort_rule_id ?? "incomplete-multipart-expire",
    temporary_bundle_prefix: input.temporary_bundle_prefix ?? "temporary/",
    kms_region: input.kms_region ?? "ap-southeast-1",
    control_plane_role_arn: input.control_plane_role_arn ?? null,
    legacy_kms_context_key: input.legacy_kms_context_key ?? null,
    episode_kms_context_cutover_complete: input.episode_kms_context_cutover_complete ?? false,
    capture_image_id: input.capture_image_id ?? 0,
    capture_image_digest: input.capture_image_digest ?? null,
    render_image_id: input.render_image_id ?? 0,
  });
  const captureDemandDefaults = () => ({
    render_image_digest: input.render_image_digest ?? null,
    release_id: input.release_id ?? "validation-only",
    capture_bootstrap_endpoint: input.capture_bootstrap_endpoint ?? null,
    render_bootstrap_endpoint: input.render_bootstrap_endpoint ?? null,
    reserved_capture_episodes: input.reserved_capture_episodes ?? 0,
    reserved_capture_participants: input.reserved_capture_participants ?? 0,
    reserved_capture_input_mbps: input.reserved_capture_input_mbps ?? 0,
    ready_spare: input.ready_spare ?? 0,
    capture_max_nodes: input.capture_max_nodes ?? 10,
    capture_episodes_per_node: input.capture_episodes_per_node ?? 1,
  });
  const nodeProfileDefaults = () => ({
    capture_capacity_inputs_migrated: input.capture_capacity_inputs_migrated ?? false,
    capture_participants_per_node: input.capture_participants_per_node ?? 40,
    capture_input_mbps_per_node: input.capture_input_mbps_per_node ?? 16,
    render_desired_nodes: input.render_desired_nodes ?? 0,
    capture_node_size: input.capture_node_size ?? "c-2",
    capture_profile_evidence_sha256: input.capture_profile_evidence_sha256 ?? null,
    render_node_size: input.render_node_size ?? "c-8",
    render_region: input.render_region ?? "blr1",
    render_gpu: input.render_gpu ?? false,
  });
  const config = { ...identityAndBucketDefaults(), ...encryptionAndImageDefaults(), ...captureDemandDefaults(), ...nodeProfileDefaults() };
  const validateIdentityAndStorage = () => {
    requireInput(digest(config.staging_evidence_digest) && digest(config.capture_image_digest) && digest(config.render_image_digest) && digest(config.recording_bucket_adoption_plan_digest), "Expected sha256:<64 lowercase hexadecimal characters> evidence and image digests.");
    requireInput(/^[a-z]{3}[0-9]+$/.test(config.capture_region) && /^[a-z][a-z0-9-]{1,31}$/.test(config.render_region), "Invalid DigitalOcean region slug.");
    requireInput(
      config.control_addresses.every((address) => cidr(address) && address.endsWith(address.includes(":") ? "/128" : "/32")),
      "control_addresses must contain only individual IPv4 /32 or IPv6 /128 addresses.",
    );
    requireInput(config.recording_bucket_name === null || /^[a-z0-9][a-z0-9-]{2,62}$/.test(config.recording_bucket_name), "Invalid R2 bucket name.");
  };
  validateIdentityAndStorage();
  const validateEncryptionAndImages = () => {
    requireInput(config.temporary_bundle_prefix === "temporary/" && config.kms_region === "ap-southeast-1", "Recording temporary prefix and KMS Singapore region are fixed contracts.");
    requireInput(config.control_plane_role_arn === null || /^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(config.control_plane_role_arn), "Invalid control-plane IAM role ARN.");
    requireInput(config.legacy_kms_context_key === null || (/^chalk\.[a-z][a-z0-9_]{1,63}$/.test(config.legacy_kms_context_key) && !contextKeys.includes(config.legacy_kms_context_key)), "Legacy KMS context key must be distinct from canonical context keys.");
    requireInput(integer(config.capture_image_id, 0) && integer(config.render_image_id, 0), "Image IDs must be nonnegative integers.");
  };
  validateEncryptionAndImages();
  const validateReleaseAndCapacity = () => {
    requireInput(/^[a-z0-9][a-z0-9._-]{0,127}$/.test(config.release_id), "Invalid bounded lowercase release ID.");
    requireInput(integer(config.ready_spare, 0) && integer(config.capture_max_nodes, 1) && integer(config.render_desired_nodes, 0, 10), "Invalid recorder capacity bounds.");
    requireInput(["s-1vcpu-1gb", "s-1vcpu-2gb", "c-2"].includes(config.capture_node_size), "Capture size must be in the bounded qualification profiles.");
    requireInput(config.capture_profile_evidence_sha256 === null || /^[a-f0-9]{64}$/.test(config.capture_profile_evidence_sha256), "Invalid smaller-profile evidence digest.");
  };
  validateReleaseAndCapacity();
  const validateAdmission = () => {
    requireInput(integer(config.reserved_capture_episodes, 0, 10) && integer(config.reserved_capture_participants, 0, 100) && config.reserved_capture_input_mbps >= 0 && config.reserved_capture_input_mbps <= 40, "Capture admission exceeds the qualified launch ceiling.");
    requireInput(integer(config.capture_episodes_per_node, 1) && config.capture_participants_per_node > 0 && config.capture_input_mbps_per_node > 0, "Capture density inputs must be positive.");
  };
  validateAdmission();
  const desired_capture_nodes = Math.max(
    Math.ceil((config.reserved_capture_episodes + config.ready_spare) / config.capture_episodes_per_node),
    Math.ceil(config.reserved_capture_participants / config.capture_participants_per_node),
    Math.ceil(config.reserved_capture_input_mbps / config.capture_input_mbps_per_node),
  );
  const validateComputeCeiling = () => {
    requireInput(desired_capture_nodes <= config.capture_max_nodes && Math.ceil(config.ready_spare / config.capture_episodes_per_node) <= config.capture_max_nodes, "Capture demand or its free-slot floor exceeds capture_max_nodes.");
    requireInput(desired_capture_nodes + config.render_desired_nodes <= 20, "Recorder demand exceeds the twenty-node compute cap.");
    requireInput(config.render_desired_nodes === 0, "IaC never mutates render runtime capacity; external reconciliation owns scale-to-zero and deadline admission.");
  };
  validateComputeCeiling();
  if (config.environment === "production") {
    const validateProductionApproval = () => {
      requireInput(config.recording_bucket_name !== null && config.recording_bucket_import_id !== null && config.recording_bucket_adoption_plan_digest !== null, "Production requires explicit existing R2 inventory and approved no-delete adoption digest.");
      requireInput(
        config.capture_capacity_inputs_migrated && ((config.legacy_kms_context_key !== null && !config.episode_kms_context_cutover_complete) || (config.legacy_kms_context_key === null && config.episode_kms_context_cutover_complete)),
        "Production requires capacity-input migration acknowledgment and exactly one KMS context cutover state.",
      );
    };
    validateProductionApproval();
  }
  if (config.enable_apply) {
    const validateApplyInputs = () => {
      requireInput(config.capture_node_size === "c-2" || config.capture_profile_evidence_sha256 !== null, "Smaller capture profiles require exact-profile one-hour qualification evidence.");
      requireInput(
        config.staging_evidence_digest !== null && config.capture_image_digest !== null && config.render_image_digest !== null && config.capture_bootstrap_endpoint !== null && config.render_bootstrap_endpoint !== null,
        "Recorder mutation requires evidence, both image digests and external one-time bootstrap endpoints.",
      );
      requireInput(!!config.control_plane_role_arn?.trim() && !!config.cloudflare_account_id?.trim(), "Recorder mutation requires the control-plane IAM role and Cloudflare account.");
    };
    validateApplyInputs();
  }
  return { ...config, desired_capture_nodes, desired_render_nodes: config.render_desired_nodes, global_recorder_compute_nodes: desired_capture_nodes + config.render_desired_nodes, bucket_name: config.recording_bucket_name ?? "chalk-recorder-nightly" };
};
export type RecorderConfig = ReturnType<typeof parseRecorderConfig>;
export const loadRecorderConfig = async () => {
  if (!process.env.CHALK_RECORDER_CONFIG_FILE) throw new Error("Set CHALK_RECORDER_CONFIG_FILE to private JSON inputs (no credentials).");
  const text = await readFile(process.env.CHALK_RECORDER_CONFIG_FILE, "utf8");
  let value: Schema.Json;
  try {
    value = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(text);
  } catch {
    throw new Error("Invalid private recorder JSON; input contents are not printed.");
  }
  return parseRecorderConfig(value);
};
