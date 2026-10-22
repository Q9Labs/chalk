import { recordingChecks } from "./recording-checks.mjs";

const [playwrightPath, origin] = process.argv.slice(2);
const { chromium } = await import(playwrightPath);
const browser = await chromium.launch({ ...(process.env.DASHBOARD_BROWSER_PATH ? { executablePath: process.env.DASHBOARD_BROWSER_PATH } : {}), headless: true });
const fixture = (query) => fetch(`${origin}/__fixture/${query}`).then((response) => response.json());
const results = [];
const errors = [];
try {
  await recordingChecks({
    CALL: "/dashboard/call/00000000-0000-4000-8000-000000000100",
    fixture,
    check: (name, ok) => results.push({ name, ok }),
    open: async (route, { width = 1440, set = "", clock = false } = {}) => {
      await fixture("reset");
      await fixture(`set?${set}`);
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addCookies([
        { name: "fx_session", value: "hasan", url: origin },
        { name: "chalk_theme", value: "dark", url: origin },
      ]);
      const tab = await context.newPage();
      tab.on("pageerror", (error) => errors.push(error.message));
      if (clock) {
        await tab.clock.install();
        await tab.clock.pauseAt(new Date(Date.now() + 1000));
      }
      await tab.goto(`${origin}${route}`, { waitUntil: "networkidle" });
      return { tab, context };
    },
  });
} finally {
  await browser.close();
  await fixture("reset");
  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}`);
  for (const error of errors) console.error(error);
}
if (errors.length || results.some((result) => !result.ok)) process.exitCode = 1;
