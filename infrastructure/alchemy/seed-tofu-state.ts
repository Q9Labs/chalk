import * as AWS from "@alchemy.run/aws";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { layerNonInteractive } from "alchemy/Interaction";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Provider from "alchemy/Provider";
import type { ResourceClassLike, ResourceLike } from "alchemy/Resource";
import { State } from "alchemy/State";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { providers, state, environmentName } from "./config.ts";
import { EipAssociation, readAssociation } from "./eip-association.ts";
import { BucketPolicy, canonicalPolicy, readPolicy } from "./bucket-policy.ts";

const tofuState = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(4),
    resources: Schema.Array(
      Schema.Struct({
        mode: Schema.Literals(["data", "managed"]),
        type: Schema.String,
        name: Schema.String,
        module: Schema.optional(Schema.String),
        instances: Schema.Array(Schema.Struct({ attributes: Schema.Unknown, deposed: Schema.optional(Schema.String) })),
      }),
    ),
  }),
);
const tags = Schema.Record(Schema.String, Schema.String);

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown, label: string): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new Error(`Invalid ${label}; state contents are not printed.`);
  }
};

const lookup = <R extends ResourceLike>(resource: ResourceClassLike<R>, props: R["Lookup"]) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(resource);
    if (!provider.lookup) return yield* Effect.die(`No lookup for ${resource.Type}`);
    const attributes = yield* provider.lookup(props);
    if (!attributes) return yield* Effect.die(`Existing ${resource.Type} was not found; refusing to seed.`);
    return attributes;
  });

const row = <P extends object, A extends object>(resourceType: string, logicalId: string, instanceId: string, props: P, attr: A, downstream: string[], removalPolicy: "retain" | "destroy" = "destroy"): CreatedResourceState => ({
  status: "created",
  resourceType,
  logicalId,
  fqn: logicalId,
  instanceId,
  namespace: undefined,
  providerVersion: 0,
  props: { ...props },
  attr: { ...attr },
  bindings: [],
  downstream,
  removalPolicy,
});

const main = Effect.gen(function* () {
  const [stack, stageInput, stateFile, mode, ...extra] = process.argv.slice(2);
  const stage = Schema.decodeUnknownSync(environmentName)(stageInput);
  if ((stack !== "recording-control-address" && stack !== "archive-cdn") || stage !== "nightly" || !stateFile || (mode !== undefined && mode !== "--dry-run") || extra.length) {
    return yield* Effect.die("Usage: tsx alchemy/seed-tofu-state.ts <recording-control-address|archive-cdn> nightly <tofu-state.json> [--dry-run]");
  }
  const source = decode(tofuState, yield* Effect.tryPromise(() => readFile(stateFile, "utf8")), "tofu state");
  const managed = source.resources.filter((resource) => resource.mode === "managed");
  const expected =
    stack === "recording-control-address" ? ["aws_eip.control", "aws_eip_association.control"] : ["aws_cloudfront_origin_access_control.archive", "aws_cloudfront_public_key.archive", "aws_cloudfront_key_group.archive", "aws_cloudfront_distribution.archive", "aws_s3_bucket_policy.artifacts"];
  if (managed.length !== expected.length || managed.some((resource) => resource.module || !expected.includes(`${resource.type}.${resource.name}`))) {
    return yield* Effect.die("Unexpected managed resources in tofu state; refusing partial migration.");
  }
  const get = <A>(type: string, name: string, schema: Schema.Codec<A>): A => {
    const matches = managed.filter((resource) => resource.type === type && resource.name === name);
    const resource = matches[0];
    const instance = resource?.instances[0];
    if (matches.length !== 1 || resource?.instances.length !== 1 || !instance || instance.deposed) {
      throw new Error(`Expected exactly one current ${type}.${name}; refusing to seed.`);
    }
    return decode(schema, instance.attributes, `${type}.${name} attributes`);
  };
  const rows: CreatedResourceState[] = [];
  if (stack === "recording-control-address") {
    const eip = get("aws_eip", "control", Schema.Struct({ id: Schema.String, domain: Schema.Literal("vpc"), tags }));
    const association = get("aws_eip_association", "control", Schema.Struct({ allocation_id: Schema.String, instance_id: Schema.String, allow_reassociation: Schema.Boolean, id: Schema.String }));
    if (association.allocation_id !== eip.id) return yield* Effect.die("Tofu association does not reference its address.");
    const address = yield* lookup(AWS.EC2.EIP, { allocationId: eip.id });
    const attached = yield* readAssociation(eip.id);
    if (!attached) return yield* Effect.die("Existing address has no instance association.");
    rows.push(row(AWS.EC2.EIP.Type, "Control", eip.id, { domain: eip.domain, tags: eip.tags } satisfies AWS.EC2.EIPProps, address, ["ControlAssociation"], "retain"));
    rows.push(
      row(
        EipAssociation.Type,
        "ControlAssociation",
        association.id,
        {
          allocationId: association.allocation_id,
          instanceId: association.instance_id,
          allowReassociation: association.allow_reassociation,
          environment: stage,
        } satisfies EipAssociation["Props"],
        attached,
        [],
      ),
    );
  } else {
    const access = get("aws_cloudfront_origin_access_control", "archive", Schema.Struct({ id: Schema.String, name: Schema.String, origin_access_control_origin_type: Schema.Literal("s3"), signing_behavior: Schema.Literal("always"), signing_protocol: Schema.Literal("sigv4") }));
    const key = get("aws_cloudfront_public_key", "archive", Schema.Struct({ id: Schema.String, name: Schema.String, encoded_key: Schema.String, caller_reference: Schema.String }));
    const group = get("aws_cloudfront_key_group", "archive", Schema.Struct({ id: Schema.String, name: Schema.String, items: Schema.Array(Schema.String) }));
    const distribution = get(
      "aws_cloudfront_distribution",
      "archive",
      Schema.Struct({
        id: Schema.String,
        caller_reference: Schema.String,
        enabled: Schema.Boolean,
        comment: Schema.String,
        http_version: Schema.Literal("http2"),
        is_ipv6_enabled: Schema.Boolean,
        price_class: Schema.Literal("PriceClass_All"),
        tags,
        origin: Schema.Array(Schema.Struct({ domain_name: Schema.String, origin_id: Schema.String, origin_access_control_id: Schema.String })),
        default_cache_behavior: Schema.Array(
          Schema.Struct({
            target_origin_id: Schema.String,
            viewer_protocol_policy: Schema.Literal("https-only"),
            allowed_methods: Schema.Array(Schema.Literals(["GET", "HEAD"])),
            cached_methods: Schema.Array(Schema.Literals(["GET", "HEAD"])),
            compress: Schema.Boolean,
            trusted_key_groups: Schema.Array(Schema.String),
            cache_policy_id: Schema.String,
          }),
        ),
      }),
    );
    const policy = get("aws_s3_bucket_policy", "artifacts", Schema.Struct({ bucket: Schema.String, policy: Schema.String }));
    const behavior = distribution.default_cache_behavior[0];
    if (!behavior || distribution.default_cache_behavior.length !== 1) return yield* Effect.die("Expected one default cache behavior.");
    const accessAttrs = yield* lookup(AWS.CloudFront.OriginAccessControl, { originAccessControlId: access.id });
    const keyAttrs = yield* lookup(AWS.CloudFront.PublicKey, { publicKeyId: key.id });
    const groupAttrs = yield* lookup(AWS.CloudFront.KeyGroup, { keyGroupId: group.id });
    const distributionAttrs = yield* lookup(AWS.CloudFront.Distribution, { distributionId: distribution.id });
    const policyAttrs = yield* readPolicy(policy.bucket);
    if (!policyAttrs) return yield* Effect.die("Existing artifacts bucket policy was not found.");
    rows.push(
      row(
        AWS.CloudFront.OriginAccessControl.Type,
        "ArchiveAccess",
        access.id,
        { name: access.name, originType: access.origin_access_control_origin_type, signingBehavior: access.signing_behavior, signingProtocol: access.signing_protocol } satisfies AWS.CloudFront.OriginAccessControl["Props"],
        accessAttrs,
        ["Archive"],
      ),
    );
    rows.push(row(AWS.CloudFront.PublicKey.Type, "ArchivePublicKey", key.caller_reference, { name: key.name, encodedKey: key.encoded_key } satisfies AWS.CloudFront.PublicKey["Props"], keyAttrs, ["ArchiveKeyGroup"]));
    rows.push(row(AWS.CloudFront.KeyGroup.Type, "ArchiveKeyGroup", group.id, { name: group.name, items: [...group.items] } satisfies AWS.CloudFront.KeyGroup["Props"], groupAttrs, ["Archive"]));
    rows.push(
      row(
        AWS.CloudFront.Distribution.Type,
        "Archive",
        distribution.caller_reference,
        {
          enabled: distribution.enabled,
          comment: distribution.comment,
          httpVersion: distribution.http_version,
          isIpv6Enabled: distribution.is_ipv6_enabled,
          priceClass: distribution.price_class,
          tags: distribution.tags,
          origins: distribution.origin.map((origin) => ({ domainName: origin.domain_name, id: origin.origin_id, originAccessControlId: origin.origin_access_control_id, s3Origin: true })),
          defaultCacheBehavior: {
            targetOriginId: behavior.target_origin_id,
            viewerProtocolPolicy: behavior.viewer_protocol_policy,
            allowedMethods: [...behavior.allowed_methods],
            cachedMethods: [...behavior.cached_methods],
            compress: behavior.compress,
            trustedKeyGroups: [...behavior.trusted_key_groups],
            cachePolicyId: behavior.cache_policy_id,
          },
          geoRestriction: { restrictionType: "none" },
          viewerCertificate: { cloudFrontDefaultCertificate: true },
        } satisfies AWS.CloudFront.Distribution["Props"],
        distributionAttrs,
        ["ArtifactsPolicy"],
      ),
    );
    rows.push(row(BucketPolicy.Type, "ArtifactsPolicy", policy.bucket, { bucket: policy.bucket, policy: canonicalPolicy(policy.policy) } satisfies BucketPolicy["Props"], policyAttrs, []));
  }
  if (mode === "--dry-run") {
    yield* Effect.logInfo(`Validated ${rows.length} live resource mappings for ${stack}/${stage}; no state written.`);
    return;
  }
  // Build and validate every row before taking the state lease or writing anything.
  const store = yield* yield* State;
  const existing = yield* store.list({ stack, stage });
  if (existing.some((fqn) => !rows.some((entry) => entry.fqn === fqn))) {
    return yield* Effect.die("Destination contains unexpected resources; refusing to seed.");
  }
  for (const entry of rows) {
    const old = yield* store.get({ stack, stage, fqn: entry.fqn });
    if (old && (!("resourceType" in old) || old.resourceType !== entry.resourceType || old.instanceId !== entry.instanceId || old.status !== "created")) {
      return yield* Effect.die(`Destination ${entry.fqn} is not this migration's completed resource; refusing to overwrite.`);
    }
  }
  for (const entry of rows) {
    if (!(yield* store.get({ stack, stage, fqn: entry.fqn }))) {
      yield* store.set({ stack, stage, fqn: entry.fqn, value: entry });
    }
    yield* Effect.logInfo(`Seeded or already present: ${stack}/${stage}/${entry.fqn}`);
  }
});

await Effect.runPromise(
  Effect.gen(function* () {
    const context = yield* Stack.build({ name: process.argv[2] ?? "", providers, state });
    yield* main.pipe(Effect.provideContext(context));
  }).pipe(
    Effect.provideService(Stage, process.argv[3] ?? ""),
    Effect.provide(AlchemyContextLive),
    Effect.provide(ProfileStoreLive),
    Effect.provide(CredentialsStoreLive),
    Effect.provide(layerNonInteractive()),
    Effect.provideService(ArtifactStore, createArtifactStore()),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(PlatformServices),
    Effect.scoped,
  ),
);
