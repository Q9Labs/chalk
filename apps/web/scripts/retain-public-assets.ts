import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const ASSET_MANIFEST = "chalk-asset-manifest.json";
const families = ["chalk-whiteboard", "chalk-mathjax"];
const rootsSchema = z.tuple([z.string().regex(/^\/chalk-whiteboard\/[a-zA-Z0-9.+-]+-[0-9a-f]{16}$/), z.string().regex(/^\/chalk-mathjax\/[a-zA-Z0-9.+-]+-[0-9a-f]{16}$/)]);
const manifestSchema = z.object({
  format: z.literal(1),
  current: rootsSchema,
  releases: z.array(z.object({ id: z.string().regex(/^[0-9a-f]{40}$/), roots: rootsSchema })).max(4),
  trees: z
    .array(
      z.object({
        root: z.string().regex(/^\/chalk-(?:whiteboard|mathjax)\/[a-zA-Z0-9.+-]+-[0-9a-f]{16}$/),
        files: z
          .array(
            z
              .string()
              .min(1)
              .max(512)
              .refine((path) => !/[\\%?#\0]/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
          )
          .min(1)
          .max(20_000),
      }),
    )
    .min(2)
    .max(8),
});

function parseManifest(input: unknown) {
  const manifest = manifestSchema.parse(input);
  const roots = manifest.trees.map((tree) => tree.root);
  if (new Set(roots).size !== roots.length || manifest.trees.some((tree) => new Set(tree.files).size !== tree.files.length)) {
    throw new Error("Duplicate asset manifest tree or file");
  }
  for (const root of [...manifest.current, ...manifest.releases.flatMap((release) => release.roots)]) {
    if (!roots.includes(root)) throw new Error(`Asset manifest has no file list for ${root}`);
  }
  if (manifest.trees.reduce((total, tree) => total + tree.files.length, 0) > 20_000) throw new Error("Asset manifest exceeds Pages' 20,000-file limit");
  return manifest;
}

export function sourceFiles(entries: [source: string, relativePath: string][]): [source: string, relativePath: string][] {
  const files: [string, string][] = [];
  for (const [source, relativePath] of entries) {
    if (!statSync(source).isDirectory()) {
      files.push([source, relativePath]);
      continue;
    }
    for (const name of readdirSync(source, { recursive: true })) {
      if (typeof name === "string" && statSync(join(source, name)).isFile()) files.push([join(source, name), join(relativePath, name)]);
    }
  }
  return files.sort(([, left], [, right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export function treeDigest(files: [source: string, relativePath: string][]): string {
  const hash = createHash("sha256");
  for (const [source, relativePath] of files) {
    const bytes = readFileSync(source);
    hash.update(`${relativePath.replaceAll("\\", "/")}\0${bytes.byteLength}\0`).update(bytes);
  }
  return hash.digest("hex").slice(0, 16);
}

async function fetchAsset(origin: string, path: string) {
  const url = new URL(path.split("/").map(encodeURIComponent).join("/"), origin);
  const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response;
}

export async function retainPublicAssets({ directory, origin, release, withoutRetention = false }: { directory: string; origin: string; release: string; withoutRetention?: boolean }) {
  const id = z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .parse(release);
  const liveOrigin = new URL(origin).origin;
  const current = parseManifest(JSON.parse(readFileSync(join(directory, ASSET_MANIFEST), "utf8")));
  let previous: z.infer<typeof manifestSchema> = { ...current, releases: [], trees: [] };
  if (withoutRetention) {
    console.warn("Asset retention explicitly disabled: older clients may lose lazy-loaded assets.");
  } else {
    try {
      previous = parseManifest(await (await fetchAsset(liveOrigin, `/${ASSET_MANIFEST}`)).json());
      if (previous.releases.length === 0) throw new Error("Live asset manifest has no deployed releases");
    } catch (error) {
      throw new Error(`Cannot retain assets from ${liveOrigin}: ${error instanceof Error ? error.message : String(error)}. Deploy stopped; use --without-asset-retention explicitly to bootstrap or discard retention.`, { cause: error });
    }
  }

  const releases = [{ id, roots: current.current }, ...previous.releases.filter((entry) => entry.id !== id).slice(0, 3)];
  const roots = [...new Set(releases.flatMap((entry) => entry.roots))];
  const trees = roots.map((root) => {
    const tree = [...current.trees, ...previous.trees].find((entry) => entry.root === root);
    if (!tree) throw new Error(`Missing retained asset tree ${root}`);
    return tree;
  });
  const manifest = parseManifest({ format: 1, current: current.current, releases, trees });
  const staging = mkdtempSync(join(dirname(resolve(directory)), ".chalk-retention-"));
  try {
    for (const tree of trees) {
      const target = join(staging, tree.root.slice(1));
      if (current.current.includes(tree.root)) {
        cpSync(join(directory, tree.root.slice(1)), target, { recursive: true });
      } else {
        const pending = tree.files.values();
        const results = await Promise.allSettled(
          Array.from({ length: 16 }, async () => {
            for (const file of pending) {
              const response = await fetchAsset(liveOrigin, `${tree.root}/${file}`);
              const bytes = Buffer.from(await response.arrayBuffer());
              if (bytes.length > 25 * 1024 * 1024) throw new Error(`Retained asset exceeds Pages' 25 MiB limit: ${tree.root}/${file}`);
              const path = join(target, file);
              mkdirSync(dirname(path), { recursive: true });
              writeFileSync(path, bytes);
            }
          }),
        );
        for (const result of results) {
          if (result.status === "rejected") {
            const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
            throw new Error(`Cannot fetch retained tree ${tree.root} from ${liveOrigin}: ${detail}. Deploy stopped; use --without-asset-retention explicitly to discard retention.`, { cause: result.reason });
          }
        }
      }
      const digest = treeDigest(sourceFiles([[target, ""]]));
      if (!tree.root.endsWith(`-${digest}`)) throw new Error(`Retained asset digest mismatch: ${tree.root}; fetched bytes have digest ${digest}; deploy stopped`);
    }
    // Replace the families, rather than accumulating trees left by warm builds.
    for (const family of families) {
      rmSync(join(directory, family), { recursive: true, force: true });
      renameSync(join(staging, family), join(directory, family));
    }
    writeFileSync(join(directory, ASSET_MANIFEST), JSON.stringify(manifest) + "\n");
    const files = sourceFiles([[directory, ""]]);
    if (files.length > 20_000) throw new Error(`Deploy exceeds Pages' 20,000-file limit: ${files.length} files`);
    if (files.some(([path]) => statSync(path).size > 25 * 1024 * 1024)) throw new Error("Deploy has an asset above Pages' 25 MiB limit");
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: "string" }, origin: { type: "string" }, release: { type: "string" }, "without-asset-retention": { type: "boolean", default: false } } });
  if (!values.directory || !values.origin || !values.release) throw new Error("Required: --directory <static assets> --origin <live origin> --release <SHA> [--without-asset-retention]");
  await retainPublicAssets({ directory: values.directory, origin: values.origin, release: values.release, withoutRetention: values["without-asset-retention"] });
}
