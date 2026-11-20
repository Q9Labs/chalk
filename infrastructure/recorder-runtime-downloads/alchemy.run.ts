import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { publicKey } from "./config.ts";
import { providers, state } from "../platform/config.ts";
import { BucketPolicy, bucketPolicyProvider, canonicalPolicy } from "../providers/aws-bucket-policy.ts";

export default Alchemy.Stack(
  "recorder-runtime-downloads",
  {
    providers: Layer.merge(providers, bucketPolicyProvider.pipe(Layer.provide(providers))),
    state,
  },
  Effect.gen(function* () {
    const { accountId } = yield* AWSEnvironment.current;
    const encodedKey = yield* publicKey;
    // One signing key serves both distributions, so a switch between them changes only the CDN URL.
    const key = yield* AWS.CloudFront.PublicKey("ArchivePublicKey", { name: "chalk-recorder-archive", encodedKey });
    const keyGroup = yield* AWS.CloudFront.KeyGroup("ArchiveKeyGroup", { name: "chalk-recorder-archive", items: [key.publicKeyId] });
    type Downloads = {
      readonly ids: { readonly access: string; readonly distribution: string; readonly policy: string };
      readonly bucketName: string;
      readonly accessName: string;
      readonly comment: string;
      readonly environment: "nightly" | "production";
      readonly purpose: string;
      readonly originId: string;
    };
    const downloads = Effect.fn(function* (props: Downloads) {
      const bucket = AWS.S3.Bucket.lookup({ bucketName: props.bucketName });
      const access = yield* AWS.CloudFront.OriginAccessControl(props.ids.access, { name: props.accessName, originType: "s3", signingBehavior: "always", signingProtocol: "sigv4" });
      const distribution = yield* AWS.CloudFront.Distribution(props.ids.distribution, {
        enabled: true,
        comment: props.comment,
        httpVersion: "http2",
        isIpv6Enabled: true,
        priceClass: "PriceClass_All",
        tags: { "chalk:environment": props.environment, "chalk:purpose": props.purpose },
        origins: [{ domainName: bucket.bucketRegionalDomainName, id: props.originId, originAccessControlId: access.originAccessControlId, s3Origin: true }],
        defaultCacheBehavior: {
          targetOriginId: props.originId,
          viewerProtocolPolicy: "https-only",
          allowedMethods: ["GET", "HEAD"],
          cachedMethods: ["GET", "HEAD"],
          compress: false,
          trustedKeyGroups: [keyGroup.keyGroupId],
          cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
        },
        geoRestriction: { restrictionType: "none" },
        viewerCertificate: { cloudFrontDefaultCertificate: true },
      });
      // The stack owns each bucket's whole policy: the provider overwrites it on every deploy.
      const policy = Output.all(bucket.bucketArn, distribution.distributionArn).pipe(
        Output.map(([arn, distributionArn]) =>
          canonicalPolicy(
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                { Sid: "DenyInsecureTransport", Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [arn, `${arn}/*`], Condition: { Bool: { "aws:SecureTransport": "false" } } },
                { Sid: "AllowRecorderArchiveCloudFront", Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject", Resource: `${arn}/recorder/*`, Condition: { StringEquals: { "AWS:SourceArn": distributionArn } } },
              ],
            }),
          ),
        ),
      );
      yield* BucketPolicy(props.ids.policy, { bucket: props.bucketName, policy });
      return distribution;
    });
    // Nightly builds publish bundles here first; its recorder/ objects expire after 45 days.
    const nightly = yield* downloads({
      ids: { access: "ArchiveAccess", distribution: "Archive", policy: "ArtifactsPolicy" },
      bucketName: `chalk-nightly-artifacts-${accountId}`,
      accessName: "chalk-recorder-archive",
      comment: "Chalk recorder archives (signed links only)",
      environment: "nightly",
      purpose: "recorder-archive-cdn",
      originId: "artifacts",
    });
    // Promote copies the exact bundles a production release pins here, and they never expire.
    const production = yield* downloads({
      ids: { access: "ProductionDownloadsAccess", distribution: "ProductionDownloads", policy: "ProductionReleasesPolicy" },
      bucketName: `chalk-production-releases-${accountId}-ap-southeast-1`,
      accessName: "chalk-recorder-runtime-downloads-production",
      comment: "Chalk production recorder runtime downloads (signed links only)",
      environment: "production",
      purpose: "recorder-runtime-downloads",
      originId: "production-releases",
    });
    return { production_distribution_url: production.url, nightly_distribution_url: nightly.url, key_pair_id: key.publicKeyId };
  }).pipe(Effect.orDie),
);
