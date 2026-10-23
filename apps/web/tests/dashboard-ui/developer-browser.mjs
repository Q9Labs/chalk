import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { developerRecordingChecks } from "./developer-recording-checks.mjs";

const [playwrightPath, origin] = process.argv.slice(2);
const { chromium } = await import(playwrightPath);
const browser = await chromium.launch({ ...(process.env.DASHBOARD_BROWSER_PATH ? { executablePath: process.env.DASHBOARD_BROWSER_PATH } : {}), headless: true });
const fixture = (query) => fetch(`${origin}/__fixture/${query}`).then((response) => response.json());
const evidence = process.env.DASHBOARD_DEVELOPER_EVIDENCE;
const results = [];
try {
  await developerRecordingChecks({
    fixture,
    check: (name, ok) => results.push({ name, ok }),
    open: async (route) => {
      await fixture("reset");
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(evidence ? { recordVideo: { dir: resolve(evidence, "videos"), size: { width: 1440, height: 1000 } } } : {}) });
      const tab = await context.newPage();
      await tab.goto(`${origin}${route}`, { waitUntil: "networkidle" });
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await tab.getByRole("combobox", { name: "Make recording videos" }).waitFor();
        await tab.screenshot({ path: resolve(evidence, "developer-on-demand.png") });
      }
      return { tab, context };
    },
  });
  if (evidence) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const tab = await context.newPage();
      await tab.goto(`${origin}/dashboard/developer`, { waitUntil: "networkidle" });
      await tab.getByRole("combobox", { name: "Make recording videos" }).selectOption("automatic");
      await tab.getByRole("button", { name: "Save recording settings" }).click();
      await tab.getByText("Recording settings saved", { exact: true }).waitFor();
      await tab.screenshot({ path: resolve(evidence, "developer-automatic.png") });
      await tab.setViewportSize({ width: 390, height: 844 });
      await tab.screenshot({ path: resolve(evidence, "developer-mobile.png") });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}`);
if (results.some((result) => !result.ok)) process.exitCode = 1;
