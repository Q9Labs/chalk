#!/usr/bin/env node
// Screenshots every call state from the harness (call-states.html) at phone,
// laptop and wide desktop sizes. Run it on two commits and compare the folders.
//
//   node scripts/capture-call-states.mjs --out artifacts/call-states/after [--only duo,board-grid]
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  laptop: { width: 1440, height: 900 },
  wide: { width: 1920, height: 1080 },
};
const { values } = parseArgs({ options: { out: { type: "string" }, only: { type: "string" }, viewports: { type: "string" }, port: { type: "string", default: "3071" } } });
const ORIGIN = `http://127.0.0.1:${values.port}`;
const SETTLE_MS = 1500;
const AFTER_ACTION_MS = 700;

if (!values.out) throw new Error("Pass --out <folder> for the screenshots.");
const outDir = resolve(values.out);
const only = values.only ? new Set(values.only.split(",")) : null;
const viewportNames = values.viewports ? values.viewports.split(",") : Object.keys(VIEWPORTS);

const server = spawn("pnpm", ["exec", "vite", "--config", "vite.call-states.config.ts", "--port", values.port], { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "ignore", "inherit"], detached: true });
let browser;
try {
  // CHROMIUM_PATH lets a machine whose Playwright browser cache is a different build run the capture.
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  await waitForServer();
  const states = await readStates();
  const selected = states.filter((state) => !only || only.has(state.id));
  const report = { capturedAt: new Date().toISOString(), states: selected, problems: [] };
  for (const viewportName of viewportNames) {
    const viewport = VIEWPORTS[viewportName];
    if (!viewport) throw new Error(`Unknown viewport ${viewportName}; use ${Object.keys(VIEWPORTS).join(", ")}.`);
    await mkdir(join(outDir, viewportName), { recursive: true });
    for (const state of selected) {
      const problems = await capture(state, viewportName, viewport).catch((error) => [{ state: state.id, viewport: viewportName, kind: "capture", message: error.message.split("\n")[0] }]);
      report.problems.push(...problems);
      console.log(`${viewportName} ${state.id}${problems.length ? ` (${problems.length} problems)` : ""}`);
    }
  }
  await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  // pnpm does not forward signals to Vite, so stop the whole process group.
  process.kill(-server.pid, "SIGTERM");
}

async function capture(state, viewportName, viewport) {
  const problems = [];
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push({ state: state.id, viewport: viewportName, kind: "pageerror", message: error.message }));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push({ state: state.id, viewport: viewportName, kind: "console", message: message.text() });
    });
    // The board waits for its stylesheet from the CDN; holding it back keeps the loading screen, as on a slow network.
    if (state.stallBoard) await page.route(/cdn\.jsdelivr\.net\/npm\/@excalidraw/, () => undefined);
    await page.goto(`${ORIGIN}/call-states.html?state=${state.id}`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(SETTLE_MS);
    for (const action of state.actions ?? []) {
      if ("wait" in action) {
        await page.waitForTimeout(action.wait);
        continue;
      }
      try {
        await page
          .getByRole(action.role ?? "button", { name: action.click })
          .first()
          .click({ timeout: 5000 });
      } catch (error) {
        problems.push({ state: state.id, viewport: viewportName, kind: "action", message: `Could not click ${action.role ?? "button"} "${action.click}": ${error.message.split("\n")[0]}` });
      }
      await page.waitForTimeout(AFTER_ACTION_MS);
    }
    await page.screenshot({ path: join(outDir, viewportName, `${state.id}.png`), animations: "disabled" });
  } finally {
    await context.close();
  }
  return problems;
}

async function readStates() {
  const page = await browser.newPage();
  await page.goto(`${ORIGIN}/call-states.html`);
  const states = await page.waitForFunction(() => window.__CALL_STATES__).then((handle) => handle.jsonValue());
  await page.close();
  return states;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${ORIGIN}/call-states.html`)).ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`The call-state harness did not start on ${ORIGIN}.`);
}
