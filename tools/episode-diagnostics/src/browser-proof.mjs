// @ts-check

import { runVisualMatrix } from "./visual-matrix.mjs";
import { pathToFileURL } from "node:url";

/**
 * Browser-proof entry point for a caller-supplied real Episode Debugger URL.
 * The deterministic API fixture is intentionally not started here: it cannot
 * prove that the product debugger UI is mounted.
 *
 * @param {{ debuggerUrl: string; browser: any; environment?: "localhost"|"development"|"staging"; outputDir?: string; screenshot?: boolean; states?: readonly string[]; viewports?: readonly number[] }} options
 */
export async function runEpisodeDiagnosticBrowserProof(options) {
  requireBrowserProofURL(options);
  return runVisualMatrix(options);
}

/** @param {any} options */
function requireBrowserProofURL(options) {
  if (options?.debuggerUrl) return;
  throw new Error("Real debugger browser proof requires debuggerUrl");
}

async function main() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const debuggerUrl = process.argv[2];
  const outputDir = process.argv[3] ?? `.private/chalk-dev/episode-diagnostics-proofs/${timestamp}`;
  try {
    const result = await runEpisodeDiagnosticBrowserProof({ debuggerUrl, browser, outputDir, screenshot: true });
    process.stdout.write(`${JSON.stringify({ status: "passed", outputDir, states: result.states.length, viewports: result.viewports, captures: result.results.length })}\n`);
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`Episode diagnostics browser proof failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
