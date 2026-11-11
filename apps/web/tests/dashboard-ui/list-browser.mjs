import { listChecks } from "./list-checks.mjs";
import { browserFixture } from "./browser-fixture.mjs";

const { browser, origin, fixture } = await browserFixture();
const results = [];
const errors = [];
try {
  await listChecks({
    origin,
    check: (name, ok) => results.push({ name, ok }),
    open: async (route, { account = "hasan", set = "", width = 1440, theme = "dark" } = {}) => {
      await fixture("reset");
      await fixture(`set?account=${account}${set ? `&${set}` : ""}`);
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addCookies([
        { name: "fx_session", value: account, url: origin },
        { name: "chalk_theme", value: theme, url: origin },
      ]);
      const tab = await context.newPage();
      tab.on("pageerror", (error) => errors.push(`${route}: ${error.message}`));
      tab.on("console", (message) => message.type() === "error" && errors.push(`${route}: ${message.text()}`));
      await tab.goto(`${origin}${route}`, { waitUntil: "networkidle" });
      return { tab, context };
    },
  });
} finally {
  await browser.close();
  await fixture("reset");
  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}`);
  for (const error of new Set(errors)) console.error(error);
}
if (errors.length || results.some((result) => !result.ok)) process.exitCode = 1;
