import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadPage } from "./download-page.mjs";

const { CHANNEL, VERSION, DOWNLOAD_ORIGIN, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, STORE_LINK_ONLY, STORE_URL } = process.env;
const refreshStoreLink = STORE_LINK_ONLY === "true";
const directory = process.argv[2];
const versionPattern = /^\d+\.\d+\.\d+$/;
if (!["staging", "production"].includes(CHANNEL) || !versionPattern.test(VERSION) || !/^\d+$/.test(GITHUB_RUN_ID) || !/^\d+$/.test(GITHUB_RUN_ATTEMPT) || DOWNLOAD_ORIGIN !== "https://downloads.chalkmeet.com" || (refreshStoreLink ? CHANNEL !== "production" : !directory)) {
  throw new Error("Expected a Helper channel, version, download origin, run ID, attempt and artifact directory.");
}

const bucket = "chalk-helper-downloads";
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[a-f0-9]{32}$/.test(account) || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error("Expected the Cloudflare account and bucket-scoped S3 credentials.");
}
const s3Endpoint = `https://${account}.r2.cloudflarestorage.com`;
const channelRoot = `helper/${CHANNEL}`;
const releaseRoot = `${channelRoot}/v${VERSION}/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`;
const macInstaller = "Chalk-Helper-macOS.dmg";
const macUpdater = "Chalk-Helper-macOS.app.tar.gz";
const publicKey = readFileSync(new URL(`./${CHANNEL}.pub`, import.meta.url), "utf8").trim();

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function url(path) {
  return `${DOWNLOAD_ORIGIN}/${path}`;
}

function signedPlatform(name, temporary) {
  const archive = join(directory, name);
  const signature = readFileSync(`${archive}.sig`, "utf8").trim();
  const decodedSignature = join(temporary, "update.minisig");
  const decodedKey = join(temporary, "update.pub");
  writeFileSync(decodedSignature, Buffer.from(signature, "base64"));
  writeFileSync(decodedKey, Buffer.from(publicKey, "base64"));
  run("minisign", ["-V", "-m", archive, "-x", decodedSignature, "-p", decodedKey]);
  return { url: url(`${releaseRoot}/${name}`), signature };
}

async function publish(source, destination, contentType, cacheControl) {
  run("aws", ["s3api", "put-object", "--endpoint-url", s3Endpoint, "--region", "auto", "--no-cli-pager", "--bucket", bucket, "--key", destination, "--body", source, "--content-type", contentType, "--cache-control", cacheControl]);
  const response = await fetch(url(destination), { signal: AbortSignal.timeout(120_000) });
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (!response.ok || sha256(Buffer.from(await response.arrayBuffer())) !== sha256(readFileSync(source))) {
    throw new Error(`Public download does not match the uploaded file: ${url(destination)}`);
  }
}

function storeDownload() {
  if (CHANNEL !== "production" || !STORE_URL) return "";
  const listing = new URL(STORE_URL);
  if (!listing.href.startsWith("https://apps.microsoft.com/")) {
    throw new Error("The Windows listing must be an https://apps.microsoft.com Microsoft Store URL.");
  }
  return listing.href;
}

function renderPage(macDownload) {
  return downloadPage({ channel: CHANNEL, version: VERSION, macDownload, storeHref: storeDownload() });
}

const latest = await fetch(url(`${channelRoot}/latest.json`), { signal: AbortSignal.timeout(30_000) });
if (!latest.ok && latest.status !== 404) {
  throw new Error(`Could not read the active update manifest: HTTP ${latest.status}`);
}
const current = latest.ok ? await latest.json() : undefined;
if (current && !versionPattern.test(current.version)) throw new Error("The active update manifest has an invalid version.");

const temporary = mkdtempSync(join(tmpdir(), "chalk-helper-release-"));
try {
  const page = join(temporary, "index.html");
  if (refreshStoreLink) {
    let macDownload;
    if (current) {
      const archive = current.platforms["darwin-aarch64"].url;
      const release = archive.slice(0, -macUpdater.length);
      const prefix = url(`${channelRoot}/v${current.version}/`);
      if (!release.startsWith(prefix) || !/^\d+-\d+\/$/.test(release.slice(prefix.length)) || archive !== release + macUpdater) {
        throw new Error("The active manifest does not point to a versioned macOS download.");
      }
      macDownload = release + macInstaller;
    }
    writeFileSync(page, renderPage(macDownload));
    await publish(page, `${channelRoot}/index.html`, "text/html; charset=utf-8", "no-store");
  } else {
    if (current && new Intl.Collator("en", { numeric: true }).compare(VERSION, current.version) <= 0) {
      throw new Error(`Refusing to replace channel version ${current.version} with ${VERSION}.`);
    }
    if (!existsSync(join(directory, macInstaller))) throw new Error("The signed macOS DMG is required.");
    const mac = signedPlatform(macUpdater, temporary);
    const platforms = { "darwin-aarch64": mac, "darwin-x86_64": mac };

    const manifest = join(temporary, "latest.json");
    writeFileSync(manifest, JSON.stringify({ version: VERSION, platforms }, null, 2) + "\n");
    writeFileSync(page, renderPage(url(`${releaseRoot}/${macInstaller}`)));

    const immutable = "public, max-age=31536000, immutable";
    await publish(join(directory, macInstaller), `${releaseRoot}/${macInstaller}`, "application/x-apple-diskimage", immutable);
    await publish(join(directory, macUpdater), `${releaseRoot}/${macUpdater}`, "application/gzip", immutable);
    await publish(manifest, `${releaseRoot}/latest.json`, "application/json", immutable);
    await publish(page, `${releaseRoot}/index.html`, "text/html; charset=utf-8", immutable);
    await publish(page, `${channelRoot}/index.html`, "text/html; charset=utf-8", "no-store");
    await publish(manifest, `${channelRoot}/latest.json`, "application/json", "no-store");
    console.log(`Published ${url(`${channelRoot}/index.html`)} from ${url(releaseRoot)}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
