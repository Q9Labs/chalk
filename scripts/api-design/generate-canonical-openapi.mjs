import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "oxfmt";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = path.join(repositoryRoot, "contract/generated/openapi.json");
const outputPath = path.join(repositoryRoot, "apps/api/docs/generated-canonical-openapi.js");

const header = `/* Generated from contract/generated/openapi.json. Do not edit by hand. */\nglobalThis.CHALK_API_DESIGN_OPENAPI = `;

export async function renderCanonicalOpenAPI(source) {
  const result = await format(outputPath, `${header}${JSON.stringify(source, null, 2)};\n`, {
    printWidth: 300,
    endOfLine: "lf",
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    insertFinalNewline: true,
  });
  if (result.errors.length > 0) throw new Error(`Canonical API design output formatting failed: ${result.errors[0].message}`);
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const rendered = await renderCanonicalOpenAPI(source);
  if (process.argv.includes("--check")) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== rendered) {
      console.error(`Canonical API design output is stale: ${path.relative(repositoryRoot, outputPath)}`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(outputPath, rendered);
    console.log(`Generated ${path.relative(repositoryRoot, outputPath)} (${Buffer.byteLength(rendered)} bytes).`);
  }
}
