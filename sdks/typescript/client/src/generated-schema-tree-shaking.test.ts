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
