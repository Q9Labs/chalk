import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("does not retain transcript settings when bundling an unrelated generated schema", async () => {
  const result = await build({
    stdin: { contents: 'export { SpaceIdSchema } from "./generated/schemas";', resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true,
    write: false,
    platform: "neutral",
    format: "esm",
    treeShaking: true,
    external: ["effect"],
    logLevel: "silent",
  });
  const output = result.outputFiles[0]?.text;
  expect(output).toContain("SpaceIdSchema");
  expect(output).not.toContain("transcript_language");
  expect(output).not.toContain("provider_policy_version");
});

it("does not bundle the service-wide API into the public call client", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./public-invites/index.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    treeShaking: true,
    external: ["effect", "effect/*"],
    logLevel: "silent",
  });
  const output = result.outputFiles[0]?.text;
  expect(output).toContain("/v1/public/space-invite-arrivals");
  expect(output).not.toContain("/v1/mcp-oauth/");
  expect(output).not.toContain("/v1/tenants/:tenant_id/api-keys");
});
