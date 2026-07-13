import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const declarationsDirectory = fileURLToPath(new URL("../dist/webhooks/", import.meta.url));
const files = await readdir(declarationsDirectory, { recursive: true });

for (const file of files) {
  if (!file.endsWith(".d.ts")) continue;
  const inputPath = join(declarationsDirectory, file);
  const outputPath = join(declarationsDirectory, `${file.slice(0, -5)}.d.cts`);
  const source = await readFile(inputPath, "utf8");
  const commonJsSource = source.replace(/(["'])(\.\.?\/[^"']+)\.js\1/gu, "$1$2.cjs$1").replace(/^\/\/# sourceMappingURL=.*$/gmu, "");
  await writeFile(outputPath, commonJsSource);
}
