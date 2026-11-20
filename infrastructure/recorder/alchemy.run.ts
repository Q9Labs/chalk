import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { environment, providers, state } from "../platform/config.ts";
import { CaptureFirewall, CaptureTag, RenderFirewall, RenderTag, recorderPoolProviders } from "../providers/digitalocean-recorder-pools.ts";
import { RecordingBucket, recordingBucketProvider } from "../providers/cloudflare-recording-bucket.ts";
import { requireCloudflareCredentials, credential } from "../platform/credentials.ts";
import { loadRecorderConfig, requireInput } from "./config.ts";
import { bucketProps, keyProps, poolFirewallProps, stackOutput } from "./resources.ts";

const cloudflare = Cloudflare.providers();
export default Alchemy.Stack(
  "recorder",
  {
    providers: Layer.mergeAll(providers, recorderPoolProviders, cloudflare, recordingBucketProvider.pipe(Layer.provide(cloudflare))),
    state,
  },
  Effect.gen(function* () {
    const stage = yield* environment;
    const config = yield* Effect.tryPromise(loadRecorderConfig);
    requireInput(config.environment === stage, "Recorder inputs must match the Alchemy stage.");
    if (!config.enable_apply) return stackOutput(config, undefined);
    credential("CHALK_CAPTURE_DIGITALOCEAN_TOKEN");
    credential("CHALK_RENDER_DIGITALOCEAN_TOKEN");
    requireCloudflareCredentials();
    const { accountId } = yield* AWSEnvironment.current;
    const cf = yield* CloudflareEnvironment.current;
    requireInput(cf.accountId === config.cloudflare_account_id, "Cloudflare credential account does not match the recorder inputs.");
    const key = yield* AWS.KMS.Key("RecordingKey", keyProps(config, accountId)).pipe(RemovalPolicy.protect());
    yield* AWS.KMS.Alias("RecordingAlias", { aliasName: `alias/chalk-recorder-${stage}`, targetKeyId: key.keyId }).pipe(RemovalPolicy.protect());
    yield* RecordingBucket("RecordingBucket", bucketProps(config)).pipe(RemovalPolicy.protect());
    yield* CaptureTag("CaptureTag", { name: "chalk-recorder-capture" }).pipe(RemovalPolicy.protect());
    yield* RenderTag("RenderTag", { name: "chalk-recorder-render" }).pipe(RemovalPolicy.protect());
    const capture = yield* CaptureFirewall("CaptureFirewall", poolFirewallProps(config, "capture")).pipe(RemovalPolicy.protect());
    const render = yield* RenderFirewall("RenderFirewall", poolFirewallProps(config, "render")).pipe(RemovalPolicy.protect());
    // Capacity, images, bootstrap endpoints and release_id are validated planning
    // metadata only. The external reconciler remains the sole runtime owner.
    return Output.all(key.keyArn, capture.firewallId, render.firewallId).pipe(Output.map(([keyArn, captureFirewallId, renderFirewallId]) => stackOutput(config, { keyArn, captureFirewallId, renderFirewallId })));
  }).pipe(Effect.orDie),
);
