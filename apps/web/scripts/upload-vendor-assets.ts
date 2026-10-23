import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assetFiles, treeDigest } from "./vendor-asset-files";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mts", "text/plain; charset=utf-8"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".txt", "text/plain; charset=utf-8"],
]);

export async function uploadVendorAssets({ directory, bucket, accountId, accessKeyId, token, apiOrigin = `https://${accountId}.r2.cloudflarestorage.com` }: { directory: string; bucket: string; accountId?: string; accessKeyId?: string; token?: string; apiOrigin?: string }) {
  // Snapshot and verify every tree before making any requests. Upload exactly those bytes.
  const files = ["chalk-whiteboard", "chalk-mathjax"].flatMap((family) => {
    const parent = join(directory, family);
    if (!existsSync(parent)) return [];
    return readdirSync(parent, { withFileTypes: true }).flatMap((entry) => {
      const digest = /^[a-zA-Z0-9.+-]+-([0-9a-f]{16})$/.exec(entry.name)?.[1];
      // Pre-digest release archives still deploy normally; their static paths stay on Pages.
      if (!entry.isDirectory() || !digest) return [];
      const root = `${family}/${entry.name}`;
      const tree = assetFiles([[join(parent, entry.name), ""]]);
      if (!tree.length || treeDigest(tree) !== digest) throw new Error(`Vendor asset digest mismatch: /${root}`);
      return tree.map(({ path, bytes }) => ({ key: `${root}/${path}`, bytes }));
    });
  });

  if (files.length && (!accountId || !accessKeyId || !token)) throw new Error("Vendor uploads require CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID and bucket-scoped CLOUDFLARE_R2_API_TOKEN");
  const client = new AwsClient({
    accessKeyId: accessKeyId ?? "",
    secretAccessKey: createHash("sha256")
      .update(token ?? "")
      .digest("hex"),
    service: "s3",
    region: "auto",
    retries: 0,
  });
  let uploaded = 0;
  let skipped = 0;
  for (const { key, bytes } of files) {
    const url = `${apiOrigin}/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const response = await client.fetch(url, {
      method: "PUT",
      headers: { "If-None-Match": "*", "Content-Type": contentTypes.get(extname(key)) ?? (key.endsWith("/LICENSE") ? "text/plain; charset=utf-8" : "application/octet-stream"), "Cache-Control": "public, max-age=31536000, immutable" },
      body: bytes,
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    if (response.status === 412) {
      skipped++;
      continue;
    }
    if (!response.ok) throw new Error(`R2 upload ${key} returned HTTP ${response.status}`);
    uploaded++;
  }
  return { uploaded, skipped };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { directory: { type: "string", default: "dist/client" }, bucket: { type: "string" } } });
  if (!values.bucket) throw new Error("--bucket is required");
  const result = await uploadVendorAssets({ directory: values.directory, bucket: values.bucket, accountId: process.env.CLOUDFLARE_ACCOUNT_ID, accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID, token: process.env.CLOUDFLARE_R2_API_TOKEN });
  console.log(`Vendor assets: uploaded ${result.uploaded}, skipped ${result.skipped}; no objects deleted`);
}
