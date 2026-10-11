import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const packageDirectory = (await readdir(join(projectRoot, "node_modules/.pnpm"))).find((entry) => entry === "image-size@2.0.3");

if (!packageDirectory) {
  throw new Error("The fixed image-size 2.0.3 package is not installed");
}

const packageRoot = join(projectRoot, "node_modules/.pnpm", packageDirectory, "node_modules/image-size/dist");
const parserEntrypoints = [
  ["ESM", join(packageRoot, "esm/index.js"), "buffer"],
  ["CommonJS", join(packageRoot, "cjs/index.js"), "buffer"],
  ["ESM fromFile", join(packageRoot, "esm/fromFile.js"), "file"],
  ["CommonJS fromFile", join(packageRoot, "cjs/fromFile.js"), "file"],
];

const malformedImages = [
  {
    name: "HEIF zero-size ispe box",
    hex: "00000010667479706176696600000000000000246d657461000000000000000869707270000000146970636f000000006973706500000000000000000000000000000000",
    error: "Invalid HEIF",
  },
  {
    name: "ICNS zero-size entry",
    hex: "69636e73000000106973333200000000",
    error: "Invalid ICNS",
  },
  {
    name: "JXL zero-size partial stream",
    hex: "000000084a584c2000000010667479706a786c2000000000000000006a786c70",
    error: "Invalid JXL",
  },
  {
    name: "unsupported bytes",
    hex: "6e6f742d616e2d696d616765",
    error: "unsupported file type",
  },
];

for (const [entrypointName, entrypointPath, mode] of parserEntrypoints) {
  for (const image of malformedImages) {
    test(`${entrypointName} rejects or bounds ${image.name}`, async () => {
      const fixtureDirectory = await mkdtemp(join(tmpdir(), "chalk-image-size-test-"));
      const fixturePath = join(fixtureDirectory, "malformed-image.bin");
      await writeFile(fixturePath, Buffer.from(image.hex, "hex"));
      try {
        assert.doesNotThrow(() => runParser({ entrypointName, entrypointPath, mode, image, fixturePath }));
      } finally {
        await rm(fixtureDirectory, { force: true, recursive: true });
      }
    });
  }
}

function runParser({ entrypointName, entrypointPath, mode, image, fixturePath }) {
  const importStatement = entrypointName.startsWith("ESM") ? `const parser = await import(${JSON.stringify(entrypointPath)});` : `const parser = require(${JSON.stringify(entrypointPath)});`;
  const invocation = mode === "buffer" ? `parser.imageSize(Buffer.from(${JSON.stringify(image.hex)}, "hex"))` : `await parser.imageSizeFromFile(${JSON.stringify(fixturePath)})`;
  const expectation = image.error ? `if (!String(error?.message).includes(${JSON.stringify(image.error)})) process.exit(3);` : `if (JSON.stringify(value) !== ${JSON.stringify(JSON.stringify(image.result))}) process.exit(4);`;
  const script = `(async () => {
${importStatement}
try {
  const value = await ${invocation};
  ${image.error ? "process.exit(2);" : expectation}
} catch (error) {
  ${image.error ? expectation : "process.exit(5);"}
}
})().catch(() => process.exit(6));`;
  execFileSync(process.execPath, entrypointName.startsWith("ESM") ? ["--input-type=module", "-e", script] : ["-e", script], {
    stdio: "ignore",
    timeout: 1000,
  });
}
