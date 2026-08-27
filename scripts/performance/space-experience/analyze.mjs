import { analyzeRun, reportJson } from "./analysis.mjs";

const runDir = process.argv[2];
if (!runDir || process.argv.includes("--help")) {
  process.stdout.write("Usage: node analyze.mjs <run-directory>\n");
  process.exitCode = runDir ? 0 : 2;
} else {
  try {
    process.stdout.write(`${reportJson(await analyzeRun(runDir))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}
