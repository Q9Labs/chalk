import { Credentials as DigitalOceanCredentials } from "@distilled.cloud/digitalocean/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

// Only protected process environments provide provider tokens. No auth-file,
// profile-token, global-key or alternate-variable fallback in Chalk stacks.
export function credential(name: "CLOUDFLARE_API_TOKEN" | "CLOUDFLARE_ACCOUNT_ID" | "DIGITALOCEAN_TOKEN" | "CHALK_CAPTURE_DIGITALOCEAN_TOKEN" | "CHALK_RENDER_DIGITALOCEAN_TOKEN") {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing ${name}; inject it from the protected operator/CI environment, not CHALK_INFRA_INPUTS`);
  return value;
}
export function requireCloudflareCredentials() {
  credential("CLOUDFLARE_API_TOKEN");
  credential("CLOUDFLARE_ACCOUNT_ID");
}
export const digitalOceanClient = (scope: "sfu" | "CAPTURE" | "RENDER") => Layer.merge(FetchHttpClient.layer, Layer.succeed(DigitalOceanCredentials,
  Effect.sync(() => ({ apiKey: Redacted.make(credential(scope === "sfu" ? "DIGITALOCEAN_TOKEN" : scope === "CAPTURE" ? "CHALK_CAPTURE_DIGITALOCEAN_TOKEN" : "CHALK_RENDER_DIGITALOCEAN_TOKEN")), apiBaseUrl: "https://api.digitalocean.com" }))));
