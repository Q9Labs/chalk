import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { publicKey } from "./config.ts";
import { nightly, providers, state } from "../platform/config.ts";
import { BucketPolicy, bucketPolicyProvider, canonicalPolicy } from "../providers/aws-bucket-policy.ts";

export default Alchemy.Stack(
  "archive-cdn",
  {
    providers: Layer.merge(providers, bucketPolicyProvider.pipe(Layer.provide(providers))),
    state,
  },
  Effect.gen(function* () {
    const environment = yield* nightly;
    const { accountId } = yield* AWSEnvironment.current;
    const bucketName = `chalk-nightly-artifacts-${accountId}`;
    const bucket = AWS.S3.Bucket.lookup({ bucketName });
    const encodedKey = yield* publicKey;
    const access = yield* AWS.CloudFront.OriginAccessControl("ArchiveAccess", {
      name: "chalk-recorder-archive",
      originType: "s3",
      signingBehavior: "always",
      signingProtocol: "sigv4",
    });
    const key = yield* AWS.CloudFront.PublicKey("ArchivePublicKey", { name: "chalk-recorder-archive", encodedKey });
    const keyGroup = yield* AWS.CloudFront.KeyGroup("ArchiveKeyGroup", { name: "chalk-recorder-archive", items: [key.publicKeyId] });
    const distribution = yield* AWS.CloudFront.Distribution("Archive", {
      enabled: true,
      comment: "Chalk recorder archives (signed links only)",
      httpVersion: "http2",
      isIpv6Enabled: true,
      priceClass: "PriceClass_All",
      tags: { "chalk:environment": environment, "chalk:purpose": "recorder-archive-cdn" },
      origins: [{ domainName: bucket.bucketRegionalDomainName, id: "artifacts", originAccessControlId: access.originAccessControlId, s3Origin: true }],
      defaultCacheBehavior: {
        targetOriginId: "artifacts",
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
    yield* BucketPolicy("ArtifactsPolicy", { bucket: bucketName, policy });
    return { distribution_url: distribution.url, key_pair_id: key.publicKeyId };
  }).pipe(Effect.orDie),
);
