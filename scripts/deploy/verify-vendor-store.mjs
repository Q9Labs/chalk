import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function vendorProbe(target) {
  const bytes = Buffer.from(`// Chalk ${target} immutable vendor store probe.\n`);
  // The uploader independently verifies this single-file tree with the normal vendor digest.
  const digest = createHash("sha256").update(`probe.js\0${bytes.length}\0`).update(bytes).digest("hex").slice(0, 16);
  const keys = ["chalk-whiteboard", "chalk-mathjax"].map((family) => `${family}/0.0.0-${digest}/probe.js`);
  return { bytes, keys };
}

export async function verifyVendorStore(target, origin = target === "nightly" ? "https://nightly.chalkmeet.com" : "https://chalkmeet.com") {
  const { bytes, keys } = vendorProbe(target);
  for (const key of keys) {
    const response = await fetch(new URL(`/${key}`, origin), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000) });
    const body = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200 || response.headers.get("Content-Type") !== "text/javascript; charset=utf-8" || response.headers.get("Cache-Control") !== "public, max-age=31536000, immutable" || !body.equals(bytes))
      throw new Error(`Vendor Worker probe failed: ${key} (status, MIME, cache or bytes)`);
    const missing = await fetch(new URL(`/${key}/missing-${randomUUID()}`, origin), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000) });
    await missing.body?.cancel();
    if (missing.status !== 404 || missing.headers.get("Cache-Control") !== "no-store") throw new Error(`Vendor Worker missing-key probe failed: ${key}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { target: { type: "string" } } });
  if (values.target !== "production" && values.target !== "nightly") throw new Error("--target production|nightly is required");
  await verifyVendorStore(values.target);
}
