import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CHALK_BACKGROUND_ASSETS } from "../../packages/assets/src/index.ts";
import { CAMERA_BACKGROUND_IMAGES, CAMERA_BACKGROUND_OPTIONS } from "../../sdks/typescript/client/src/media/camera-background-images.ts";

test("picker and camera processor use the manifest URLs in camera-specific order", () => {
  assert.deepEqual(
    CAMERA_BACKGROUND_OPTIONS.map(({ label }) => label),
    ["None", "Blur", "Office", "Home office", "Studio", "Garden", "Glass", "Lounge"],
  );
  for (const [id, asset] of Object.entries(CHALK_BACKGROUND_ASSETS)) {
    const expected = { avif: asset.avif.url, image: asset.webp.url };
    const { avif, image } = CAMERA_BACKGROUND_IMAGES[id];
    assert.deepEqual({ avif, image }, expected);
    const option = CAMERA_BACKGROUND_OPTIONS.find((entry) => entry.id === id);
    assert.deepEqual({ avif: option.avif, image: option.image }, expected);
  }
});

test("the generated check rejects manifest drift and regeneration repairs it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chalk-background-urls-"));
  const changedUrl = "https://assets.test/updated-background.avif";
  try {
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    for (const file of ["scripts/codegen/camera-background-urls.mjs", "packages/assets/src/index.ts", "sdks/typescript/client/src/media/camera-background-urls.generated.ts", "sdks/typescript/client/src/media/camera-background-images.ts"]) {
      const destination = path.join(root, file);
      await mkdir(path.dirname(destination), { recursive: true });
      const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
      await writeFile(destination, file.endsWith("index.ts") ? source.replaceAll(CHALK_BACKGROUND_ASSETS["modern-acoustic-office"].avif.url, changedUrl) : source);
    }
    const command = ["--experimental-strip-types", path.join(root, "scripts/codegen/camera-background-urls.mjs")];
    assert.throws(() => execFileSync(process.execPath, command, { stdio: "pipe" }), /Stale camera background URLs/);
    execFileSync(process.execPath, [...command, "--write"]);
    execFileSync(process.execPath, command);
    assert.match(await readFile(path.join(root, "sdks/typescript/client/src/media/camera-background-urls.generated.ts"), "utf8"), /updated-background\.avif/);
    const consumer = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `import { CAMERA_BACKGROUND_IMAGES, CAMERA_BACKGROUND_OPTIONS } from ${JSON.stringify(path.join(root, "sdks/typescript/client/src/media/camera-background-images.ts"))}; console.log(JSON.stringify([CAMERA_BACKGROUND_IMAGES["modern-acoustic-office"].avif, CAMERA_BACKGROUND_OPTIONS.find(({id}) => id === "modern-acoustic-office").avif]));`,
      ],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(consumer), Array(2).fill(changedUrl));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
