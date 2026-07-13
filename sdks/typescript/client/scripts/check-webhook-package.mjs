import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";

const packageDirectory = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", packageDirectory), "utf8"));
const dependencies = Object.keys(packageJson.dependencies ?? {});
for (const framework of ["express", "hono", "next"]) {
  if (dependencies.includes(framework)) throw new Error(`Webhook receiver added forbidden framework dependency: ${framework}`);
}

const rootBundle = await readFile(new URL("dist/index.js", packageDirectory), "utf8");
if (rootBundle.includes("WebhookVerificationError") || rootBundle.includes("webhook-signature")) {
  throw new Error("The package root bundle contains webhook receiver code.");
}
const webhookBundle = await readFile(new URL("dist/webhooks/index.js", packageDirectory), "utf8");
const webhookCommonJsBundle = await readFile(new URL("dist/webhooks/index.cjs", packageDirectory), "utf8");
if (webhookBundle.includes("TestOnlyInMemoryWebhookInbox") || webhookCommonJsBundle.includes("TestOnlyInMemoryWebhookInbox")) {
  throw new Error("The production webhook entry contains the test-only in-memory inbox.");
}

const bundleImport = async (specifier, conditions, format, syntax, useExports = false) => {
  const contents = useExports ? (syntax === "import" ? `import * as entry from "${specifier}"; globalThis.__chalkEntry = entry;` : `globalThis.__chalkEntry = require("${specifier}");`) : syntax === "import" ? `import "${specifier}";` : `require("${specifier}");`;
  const bundled = await build({
    absWorkingDir: packageDirectory.pathname,
    bundle: true,
    conditions,
    format,
    platform: "neutral",
    stdin: { contents, resolveDir: packageDirectory.pathname },
    write: false,
  });
  return bundled.outputFiles[0]?.text ?? "";
};

for (const specifier of ["@q9labsai/chalk-client/webhooks", "@q9labsai/chalk-client/webhooks/test"]) {
  const output = await bundleImport(specifier, ["import", "node"], "esm", "import", true);
  if (!output.includes(specifier.endsWith("/test") ? "TestOnlyInMemoryWebhookInbox" : "verifyWebhook")) {
    throw new Error(`${specifier} did not bundle through its Node ESM entry.`);
  }
}

for (const condition of ["browser", "react-native"]) {
  for (const specifier of ["@q9labsai/chalk-client/webhooks", "@q9labsai/chalk-client/webhooks/test"]) {
    for (const syntax of ["import", "require"]) {
      const format = syntax === "import" ? "esm" : "cjs";
      const output = await bundleImport(specifier, [condition, syntax], format, syntax);
      if (!output.includes("WebhookServerOnlyError") || output.includes("verifyWebhook") || output.includes("TestOnlyInMemoryWebhookInbox")) {
        throw new Error(`${condition} ${syntax} did not resolve ${specifier} to the server-only guard.`);
      }
      try {
        if (format === "esm") {
          await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
        } else {
          Function(output)();
        }
        throw new Error(`${condition} ${syntax} ${specifier} did not throw.`);
      } catch (error) {
        if (error?.name !== "WebhookServerOnlyError") throw error;
      }
    }
  }
}

const serverModule = await import("@q9labsai/chalk-client/webhooks");
const testModule = await import("@q9labsai/chalk-client/webhooks/test");
const require = createRequire(import.meta.url);
const serverCommonJsModule = require("@q9labsai/chalk-client/webhooks");
const testCommonJsModule = require("@q9labsai/chalk-client/webhooks/test");
if (typeof serverModule.verifyWebhook !== "function" || typeof testModule.signTestOnlyWebhook !== "function" || typeof serverCommonJsModule.verifyWebhook !== "function" || typeof testCommonJsModule.signTestOnlyWebhook !== "function") {
  throw new Error("Webhook package subpaths did not resolve through Node ESM and CommonJS.");
}
