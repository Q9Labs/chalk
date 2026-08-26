import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export const assistantFontFiles = Object.freeze(["Assistant-Regular.woff2", "Assistant-Medium.woff2", "Assistant-SemiBold.woff2", "Assistant-Bold.woff2"]);

export function inlineAssistantFonts(css, fonts) {
  return assistantFontFiles.reduce((result, fileName) => {
    const sourceUrl = `url(\"./fonts/Assistant/${fileName}\")`;
    const font = fonts[fileName];
    if (!font) throw new Error(`Missing Excalidraw Assistant font: ${fileName}`);

    const replacement = `url(\"data:font/woff2;base64,${font.toString("base64")}\")`;
    const occurrences = result.split(sourceUrl).length - 1;
    if (occurrences !== 1) throw new Error(`Expected one Excalidraw Assistant font reference for ${fileName}, found ${occurrences}`);
    return result.replace(sourceUrl, replacement);
  }, css);
}

export async function buildReactStylesheet(root = packageRoot) {
  const excalidrawRoot = await findPackageRoot(require.resolve("@excalidraw/excalidraw"), "@excalidraw/excalidraw");
  const excalidrawProd = join(excalidrawRoot, "dist", "prod");
  const fonts = Object.fromEntries(await Promise.all(assistantFontFiles.map(async (fileName) => [fileName, await readFile(join(excalidrawProd, "fonts", "Assistant", fileName))])));
  const css = inlineAssistantFonts(await readFile(join(excalidrawProd, "index.css"), "utf8"), fonts);
  const outputPath = join(root, "dist", "react", "index.css");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, css);
  return outputPath;
}

async function findPackageRoot(entryPoint, expectedName) {
  let directory = dirname(entryPoint);
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name === expectedName) return directory;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Unable to resolve package root for ${expectedName}`);
    directory = parent;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildReactStylesheet();
