import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const files = JSON.parse(readFileSync(0, "utf8"));
const manifestPath = createRequire(import.meta.url).resolve("oxfmt/package.json");
const { bin } = JSON.parse(readFileSync(manifestPath, "utf8"));
const entry = resolve(dirname(manifestPath), bin.oxfmt);

// Run the formatter's declared Node CLI without sending the file list through a shell or a process command line.
process.argv = [process.execPath, entry, "--check", ...files];
await import(pathToFileURL(entry).href);
