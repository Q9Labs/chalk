import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeClientBuildManifest } from "./ui-build.js";
import { resolveVerifiedClientBuild, writeUIBuildRegistry } from "./ui-build-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("recording UI build registry", () => {
  it("selects a verified retained client build by its sealed digest", async () => {
    const root = await createRegistryRoot();
    await writeClient(root, "client", "current");
    const retained = await writeRetainedClient(root, "retained");
    await writeUIBuildRegistry(root);

    await expect(resolveVerifiedClientBuild(root, retained.sha256)).resolves.toBe(retained.directory);
  });

  it("fails closed when the sealed digest is not installed", async () => {
    const root = await createRegistryRoot();
    await writeClient(root, "client", "current");
    await writeUIBuildRegistry(root);

    await expect(resolveVerifiedClientBuild(root, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toThrow("unavailable");
  });

  it("rejects a retained client tree that changed after its manifest was sealed", async () => {
    const root = await createRegistryRoot();
    await writeClient(root, "client", "current");
    const retained = await writeRetainedClient(root, "retained");
    await writeUIBuildRegistry(root);
    await writeFile(join(retained.directory, "index.html"), "tampered", "utf8");

    await expect(resolveVerifiedClientBuild(root, retained.sha256)).rejects.toThrow("does not match");
  });

  it("rejects a registry path outside the immutable renderer directory", async () => {
    const root = await createRegistryRoot();
    const current = await writeClient(root, "client", "current");
    await writeFile(
      join(root, "recording-ui-builds.json"),
      JSON.stringify({
        schema_version: "recording_ui_build_registry.v1",
        builds: [{ sha256: current.sha256, directory: "../client" }],
      }),
      "utf8",
    );

    await expect(resolveVerifiedClientBuild(root, current.sha256)).rejects.toThrow("registry is invalid");
  });
});

async function createRegistryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chalk-recording-ui-build-registry-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeClient(root: string, relativeDirectory: string, contents: string): Promise<{ readonly directory: string; readonly sha256: string }> {
  const directory = join(root, relativeDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.html"), contents, "utf8");
  const sha256 = await writeClientBuildManifest(directory);
  return { directory, sha256 };
}

async function writeRetainedClient(root: string, contents: string): Promise<{ readonly directory: string; readonly sha256: string }> {
  const staged = await writeClient(root, "staged-client", contents);
  const directory = join(root, "retained-clients", staged.sha256);
  await mkdir(join(root, "retained-clients"), { recursive: true });
  await rename(staged.directory, directory);
  return { directory: await realpath(directory), sha256: staged.sha256 };
}
