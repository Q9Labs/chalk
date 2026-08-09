import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const malformedImages = [
  ["icns-zero-entry-length", "69636e73000000106973333200000000"],
  ["heif-zero-box-length", "00000010667479706176696600000000000000246d657461000000000000000869707270000000146970636f000000006973706500000000000000000000000000000000"],
];

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const patchedPackageDirectory = readdirSync(join(projectRoot, "node_modules/.pnpm")).find((entry) => entry.startsWith("image-size@2.0.2_patch_hash="));

if (!patchedPackageDirectory) {
  throw new Error("The patched image-size package is not installed");
}

const packageRoot = join(projectRoot, "node_modules/.pnpm", patchedPackageDirectory, "node_modules/image-size/dist");
const moduleCases = [
  ["ESM", join(packageRoot, "index.mjs")],
  ["CommonJS", join(packageRoot, "index.cjs")],
];

for (const [moduleName, modulePath] of moduleCases) {
  test(`${moduleName} image-size parser rejects zero-length boxes without hanging`, () => {
    const importStatement = moduleName === "ESM" ? `import { imageSize } from ${JSON.stringify(modulePath)};` : `const { imageSize } = require(${JSON.stringify(modulePath)});`;
    const script = `${importStatement}\nfor (const hex of ${JSON.stringify(malformedImages.map(([, hex]) => hex))}) { try { imageSize(Buffer.from(hex, \"hex\")); } catch {} }`;

    execFileSync(process.execPath, moduleName === "ESM" ? ["--input-type=module", "-e", script] : ["-e", script], {
      stdio: "ignore",
      timeout: 1000,
    });
  });
}
