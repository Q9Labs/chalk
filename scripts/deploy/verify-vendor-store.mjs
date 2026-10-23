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
    const message = `Vendor Worker probe failed: ${key}`;
    assert.equal(response.status, 200, message);
    assert.equal(response.headers.get("Content-Type"), "text/javascript; charset=utf-8", message);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable", message);
    assert.ok(body.equals(bytes), message);
    const missing = await fetch(new URL(`/${key}/missing-${randomUUID()}`, origin), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000) });
    await missing.arrayBuffer();
    assert.equal(missing.status, 404, `Vendor Worker missing-key probe failed: ${key}`);
    assert.equal(missing.headers.get("Cache-Control"), "no-store", `Vendor Worker missing-key probe failed: ${key}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { target: { type: "string" } } });
  if (values.target !== "production" && values.target !== "nightly") throw new Error("--target production|nightly is required");
  await verifyVendorStore(values.target);
}
import assert from "node:assert/strict";
