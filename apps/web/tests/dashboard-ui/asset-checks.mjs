import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [playwrightPath, origin] = process.argv.slice(2);
const { chromium } = await import(playwrightPath);
const browser = await chromium.launch({ headless: true });
try {
  const report = [];
  for (const [name, route] of [
    ["landing", "/"],
    ["sign-in", "/dashboard/sign-in"],
    ["dashboard", "/dashboard"],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    try {
      if (name === "dashboard") await context.addCookies([{ name: "fx_session", value: "hasan", url: origin }]);
      const requests = [];
      const failed = [];
      context.on("request", (request) => requests.push({ url: request.url(), type: request.resourceType() }));
      context.on("response", (response) => {
        if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
      });
      const page = await context.newPage();
      await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
      if (name === "dashboard") await page.getByRole("button", { name: "Start a call", exact: true }).waitFor();
      if (name === "sign-in") await page.getByRole("button", { name: "Continue with Google", exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const fonts = await page.evaluate(() => Array.from(document.fonts, (font) => ({ family: font.family, weight: font.weight, status: font.status })));
      const external = requests.filter(({ url }) => /^https?:/.test(url) && new URL(url).origin !== origin);
      report.push({ name, requests, failed, fonts, external });
      if (process.env.ASSET_PROOF_DIR) {
        await mkdir(process.env.ASSET_PROOF_DIR, { recursive: true });
        await page.screenshot({ path: resolve(process.env.ASSET_PROOF_DIR, `${name}.png`) });
      }
    } finally {
      await context.close();
    }
  }
  if (process.env.ASSET_PROOF_DIR) await writeFile(resolve(process.env.ASSET_PROOF_DIR, "web-requests.json"), JSON.stringify(report, null, 2));
  for (const { name, external, failed, fonts } of report) {
    assert.deepEqual(external, [], `${name} sent an external request`);
    assert.deepEqual(failed, [], `${name} failed to load an asset`);
    assert(
      fonts.some((font) => font.family === "Figtree" && font.status === "loaded"),
      `${name} did not render Figtree`,
    );
    if (name === "sign-in")
      assert(
        fonts.some((font) => font.family === "Roboto" && font.status === "loaded"),
        "Sign-in did not render Roboto",
      );
  }
  console.log("PASS: landing, sign-in and dashboard asset requests and loaded fonts");
} finally {
  await browser.close();
}
