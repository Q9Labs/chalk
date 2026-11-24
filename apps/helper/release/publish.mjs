import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { CHANNEL, VERSION, DOWNLOAD_ORIGIN, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, STORE_URL } = process.env;
const directory = process.argv[2];
const versionPattern = /^\d+\.\d+\.\d+$/;
if (
  !["staging", "production"].includes(CHANNEL) ||
  !versionPattern.test(VERSION) ||
  !/^\d+$/.test(GITHUB_RUN_ID) ||
  !/^\d+$/.test(GITHUB_RUN_ATTEMPT) ||
  DOWNLOAD_ORIGIN !== "https://downloads.chalkmeet.com" ||
  !directory
) {
  throw new Error("Expected a Helper channel, version, download origin, run ID, attempt and artifact directory.");
}

const bucket = "chalk-helper-downloads";
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
  run("wrangler", [
    "r2", "object", "put", `${bucket}/${destination}`, "--remote",
    "--file", source, "--content-type", contentType, "--cache-control", cacheControl,
  ]);
  const response = await fetch(url(destination), { signal: AbortSignal.timeout(120_000) });
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (!response.ok || sha256(Buffer.from(await response.arrayBuffer())) !== sha256(readFileSync(source))) {
    throw new Error(`Public download does not match the uploaded file: ${url(destination)}`);
  }
}

const latest = await fetch(url(`${channelRoot}/latest.json`), { signal: AbortSignal.timeout(30_000) });
if (latest.ok) {
  const { version } = await latest.json();
  if (!versionPattern.test(version) || new Intl.Collator("en", { numeric: true }).compare(VERSION, version) <= 0) {
    throw new Error(`Refusing to replace channel version ${version} with ${VERSION}.`);
  }
} else if (latest.status !== 404) {
  throw new Error(`Could not read the active update manifest: HTTP ${latest.status}`);
}

const temporary = mkdtempSync(join(tmpdir(), "chalk-helper-release-"));
try {
  if (!existsSync(join(directory, macInstaller))) throw new Error("The signed macOS DMG is required.");
  const mac = signedPlatform(macUpdater, temporary);
  const platforms = { "darwin-aarch64": mac, "darwin-x86_64": mac };


  const manifest = join(temporary, "latest.json");
  writeFileSync(manifest, JSON.stringify({ version: VERSION, platforms }, null, 2) + "\n");
  const page = join(temporary, "index.html");
  const title = CHANNEL === "staging" ? "Chalk Helper for Chalk Nightly" : "Chalk Helper";
  let windows = "";
  if (CHANNEL === "production" && STORE_URL) {
    const listing = new URL(STORE_URL);
    if (listing.origin !== "https://apps.microsoft.com" || listing.username || listing.password) {
      throw new Error("The Windows listing must be an https://apps.microsoft.com Microsoft Store URL.");
    }
    const href = listing.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    windows = `  <p><a href="${href}">Get it from the Microsoft Store</a></p>\n`;
  }
  writeFileSync(page, `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<main>
  <h1>${title}</h1>
  <p>See other participants’ annotations while you share your screen in Chalk.</p>
  <p><a href="${url(`${releaseRoot}/${macInstaller}`)}">Download for macOS 14 or later</a> (Apple silicon and Intel)</p>
${windows}</main>
</html>
`);

  const immutable = "public, max-age=31536000, immutable";
  await publish(join(directory, macInstaller), `${releaseRoot}/${macInstaller}`, "application/x-apple-diskimage", immutable);
  await publish(join(directory, macUpdater), `${releaseRoot}/${macUpdater}`, "application/gzip", immutable);
  await publish(manifest, `${releaseRoot}/latest.json`, "application/json", immutable);
  await publish(page, `${releaseRoot}/index.html`, "text/html; charset=utf-8", immutable);
  await publish(page, `${channelRoot}/index.html`, "text/html; charset=utf-8", "no-store");
  await publish(manifest, `${channelRoot}/latest.json`, "application/json", "no-store");
  console.log(`Published ${url(`${channelRoot}/index.html`)} from ${url(releaseRoot)}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
