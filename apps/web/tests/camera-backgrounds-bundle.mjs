// Compare matched production builds, the SDK consumer demo, and packed React SDKs.
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { gzipSync } from "node:zlib";
import { measureRouteBundle } from "../scripts/call-route-bundle.mjs";

const [baseRoot, headRoot, baseArchive, headArchive, output] = process.argv.slice(2);
assert(output, "Pass base/head repository paths, base/head React tarballs, and an output JSON path");
const browser = await chromium.launch();
const report = { route: "/space/performance-budget", baseline: execFileSync("git", ["rev-parse", "HEAD"], { cwd: baseRoot, encoding: "utf8" }).trim(), head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: headRoot, encoding: "utf8" }).trim(), builds: {}, added: {} };
try {
  for (const [label, root, archive] of [
    ["base", baseRoot, baseArchive],
    ["head", headRoot, headArchive],
  ]) {
    const web = resolve(root, "apps/web");
    const measured = await measureRouteBundle({ browser, web });
    const scripts = measured.loaded.filter(({ path }) => path.endsWith(".js"));
    let initialJsBytes = 0;
    for (const { path } of scripts) initialJsBytes += (await readFile(resolve(web, `dist/client${path}`))).length;
    assert(!scripts.some(({ path }) => /camera-effects-provider|vision_bundle|vision_wasm|selfie-segmenter/.test(path)), "No segmentation runtime in initial JS");
    const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    assert(!files.some((file) => /\.(wasm|tflite|avif|webp|jpg)$/.test(file)), "React tarball must not contain model, WASM or pictures");
    const demo = await readFile(resolve(root, "tools/sdk-web-consumer-e2e/consumer/dist/bundle.js"));
    report.builds[label] = { reactTarballBytes: (await stat(archive)).size, initialJsBytes, initialJsGzipBytes: Math.round(measured.routeJsGzipKiB * 1024), demoInitialJsBytes: demo.length, demoInitialJsGzipBytes: gzipSync(demo, { level: 9 }).length, initialScripts: scripts };
  }
  for (const key of ["reactTarballBytes", "initialJsBytes", "initialJsGzipBytes", "demoInitialJsBytes", "demoInitialJsGzipBytes"]) report.added[key] = report.builds.head[key] - report.builds.base[key];
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.added));
} finally {
  await browser.close();
}
