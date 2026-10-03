import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDirectory = path.join(repositoryRoot, "apps/api/db/migrations");
const embedPath = path.join(migrationsDirectory, "embed.go");
const latestVersionPattern = /^(const LatestVersion int64 = )(\d+)$/m;

export async function latestMigrationVersion(directory = migrationsDirectory) {
  const versions = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      const prefix = name.split("_")[0];
      if (!/^\d+$/.test(prefix)) throw new Error(`Migration ${name} has no numeric version prefix`);
      return prefix;
    });
  if (versions.length === 0) throw new Error(`No migrations found in ${directory}`);
  return versions.reduce((latest, version) => (BigInt(version) > BigInt(latest) ? version : latest));
}

export async function declaredLatestVersion(source) {
  const match = latestVersionPattern.exec(source);
  if (!match) throw new Error("apps/api/db/migrations/embed.go has no `const LatestVersion int64 = <version>` line");
  return match[2];
}

async function main() {
  const write = process.argv.includes("--write");
  const source = await readFile(embedPath, "utf8");
  const declared = await declaredLatestVersion(source);
  const latest = await latestMigrationVersion();
  if (declared === latest) return;
  if (!write) {
    throw new Error(`apps/api/db/migrations/embed.go LatestVersion is ${declared} but the latest migration is ${latest}; run pnpm run regen`);
  }
  await writeFile(embedPath, source.replace(latestVersionPattern, `$1${latest}`));
  console.log(`Set LatestVersion to ${latest}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
