import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(scriptDir, "../public");
const blankHtml = '<!doctype html><html><head><meta charset="utf-8" /></head><body></body></html>\n';

function writePublicFile(relativePath: string, contents: string) {
  const outputPath = resolve(publicDir, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents);
}

writePublicFile("privacy/index.html", blankHtml);
writePublicFile("terms/index.html", blankHtml);
writePublicFile("privacy-policy/index.html", blankHtml);
