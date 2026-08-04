import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageDirectory = new URL("../", import.meta.url);
const packagePath = packageDirectory.pathname;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "chalk-react-native-client-package-"));
const archiveDirectory = join(temporaryDirectory, "archive");
const installedPackageDirectory = join(temporaryDirectory, "node_modules", "@q9labsai", "chalk-react-native");

try {
  await mkdir(archiveDirectory);
  await exec("pnpm", ["pack", "--pack-destination", archiveDirectory], { cwd: packagePath });
  const archiveName = (await readdir(archiveDirectory)).find((file) => file.endsWith(".tgz"));
  if (!archiveName) throw new Error("pnpm pack did not produce an archive.");

  await mkdir(installedPackageDirectory, { recursive: true });
  await exec("tar", ["-xzf", join(archiveDirectory, archiveName), "--strip-components=1", "-C", installedPackageDirectory]);

  const packedManifest = JSON.parse(await readFile(join(installedPackageDirectory, "package.json"), "utf8"));
  const clientExport = packedManifest.exports?.["./client"];
  if (clientExport?.types !== "./dist/client.d.ts" || clientExport?.["react-native"] !== "./dist/client.js" || clientExport?.import !== "./dist/client.js") {
    throw new Error("The packed client subpath does not expose its native ESM and declaration entries.");
  }
  if (packedManifest.typesVersions?.["*"]?.client?.[0] !== "./dist/client.d.ts") {
    throw new Error("The packed client subpath does not expose its TypeScript fallback declaration entry.");
  }

  const declaration = await readFile(join(installedPackageDirectory, "dist", "client.d.ts"), "utf8");
  const implementation = await readFile(join(installedPackageDirectory, "dist", "client.js"), "utf8");
  if (!declaration.includes("createNativeSpaceClient") || !declaration.includes("NativeSpaceClientOptions") || !implementation.includes("createNativeSpaceClient")) {
    throw new Error("The packed client subpath does not contain the public native adapter symbols.");
  }

  const consumerPath = join(temporaryDirectory, "consumer.mjs");
  await writeFile(consumerPath, 'process.stdout.write(import.meta.resolve("@q9labsai/chalk-react-native/client"));');
  const { stdout } = await exec(process.execPath, [consumerPath]);
  if (stdout.trim() !== pathToFileURL(await realpath(join(installedPackageDirectory, "dist", "client.js"))).href) {
    throw new Error("The packed client subpath does not resolve through the public package export.");
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
