import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { check, command, save } from "./runtime.mjs";

const baselineVersion = "5.2.6";

export async function baselineEntry(run) {
  const metadata = await fetch(`https://registry.npmjs.org/@q9labsai%2fchalk-client/${baselineVersion}`, { signal: AbortSignal.timeout(30_000) });
  check(metadata.ok, "Baseline npm metadata is unavailable");
  const release = await metadata.json();
  const response = await fetch(release.dist.tarball, { signal: AbortSignal.timeout(30_000) });
  check(response.ok, "Baseline npm tarball is unavailable");
  const archive = Buffer.from(await response.arrayBuffer());
  check(`sha512-${createHash("sha512").update(archive).digest("base64")}` === release.dist.integrity, "Baseline tarball integrity mismatch");
  const directory = resolve(run.directory, "leave-baseline");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "baseline.tgz");
  await writeFile(path, archive);
  await command("tar", ["-xzf", path, "-C", directory], { signal: run.signal });
  const manifest = JSON.parse(await readFile(resolve(directory, "package/package.json"), "utf8"));
  check(manifest.version === baselineVersion, "Wrong baseline SDK version");
  await save(`${run.directory}/leave-baseline-integrity.json`, { version: baselineVersion, integrity: release.dist.integrity });
  return resolve(directory, "package", manifest.exports["."].import);
}
