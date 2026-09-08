import { analyzeRun, compareReports, reportJson } from "./analysis.mjs";

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir || process.argv.includes("--help")) {
  process.stdout.write("Usage: node compare.mjs <before-run-directory> <after-run-directory>\n");
  process.exitCode = beforeDir && afterDir ? 0 : 2;
} else {
  try {
    const [before, after] = await Promise.all([analyzeRun(beforeDir), analyzeRun(afterDir)]);
    process.stdout.write(`${reportJson(compareReports(before, after))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}
