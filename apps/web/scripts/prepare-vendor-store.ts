import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { uploadVendorAssets } from "./upload-vendor-assets";
import { vendorProbe, verifyVendorStore } from "../../../scripts/deploy/verify-vendor-store.mjs";

type Target = "production" | "nightly";
type Options = Omit<Parameters<typeof uploadVendorAssets>[0], "bucket"> & { target: Target; origin?: string; wrangler?: string; verifyOnly?: boolean };

export async function prepareVendorStore({ target, origin = target === "nightly" ? "https://nightly.chalkmeet.com" : "https://chalkmeet.com", wrangler = resolve(import.meta.dirname, "../../../node_modules/.bin/wrangler"), verifyOnly = false, ...upload }: Options) {
  const bucket = target === "nightly" ? "chalk-vendor-assets-nightly" : "chalk-vendor-assets";
  const options = { ...upload, bucket };
  await uploadVendorAssets(options);
  // These R2-only objects prove both routes and their binding, even for pre-digest archives.
  const { bytes, keys } = vendorProbe(target);
  const directory = mkdtempSync(join(tmpdir(), "chalk-vendor-probe-"));
  try {
    for (const key of keys) {
      mkdirSync(join(directory, key, ".."), { recursive: true });
      writeFileSync(join(directory, key), bytes);
    }
    await uploadVendorAssets({ ...options, directory });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (!verifyOnly) {
    const deployed = spawnSync(wrangler, ["deploy", "--config", resolve(import.meta.dirname, "../wrangler.vendor-assets.toml"), ...(target === "nightly" ? ["--env", "nightly"] : [])], { stdio: "inherit" });
    if (deployed.error) throw deployed.error;
    if (deployed.status !== 0) throw new Error(`Vendor Worker deployment failed: ${deployed.status}`);
  }
  await verifyVendorStore(target, origin);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { directory: { type: "string", default: "dist/client" }, target: { type: "string" }, "verify-only": { type: "boolean", default: false } } });
  if (values.target !== "production" && values.target !== "nightly") throw new Error("--target production|nightly is required");
  await prepareVendorStore({ directory: values.directory, target: values.target, verifyOnly: values["verify-only"], accountId: process.env.CLOUDFLARE_ACCOUNT_ID, accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID, token: process.env.CLOUDFLARE_R2_API_TOKEN });
  console.log("Vendor Worker routes, R2 binding, immutable bytes/MIME and uncached 404s verified before Pages");
}
