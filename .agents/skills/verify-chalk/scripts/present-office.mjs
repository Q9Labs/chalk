#!/usr/bin/env node
// Presents Office files on the Stage: A presents each fixture, B must see the document viewer with a rendered page.
// A password-protected file must produce a failed document with a user-facing reason.
//
//   node .agents/skills/verify-chalk/scripts/present-office.mjs <run-id> --files <dir> [--web <origin>]
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { webMediaFixture } from "../../../../scripts/web-proof/media.mjs";

const runId = process.argv[2];
const arg = (name) => (process.argv.indexOf(name) > 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const dir = arg("--files");
if (!runId || !dir) throw new Error("usage: present-office.mjs <run-id> --files <dir> [--web <origin>]");
const out = join(".verify", runId);
const seed = JSON.parse(await readFile(".private/chalk-dev/seed.json", "utf8"));
const web = arg("--web") ?? seed.urls.public;
const cases = [
  { file: "pptx-security.pptx", expect: "ready" },
  { file: "locked-pass.docx", expect: "password_protected" },
  { file: "arabic-urdu.docx", expect: "ready" },
  { file: "wide-grades.xlsx", expect: "ready" },
];
await mkdir(join(out, "screenshots"), { recursive: true });
await mkdir(join(out, "video"), { recursive: true });
const steps = [];
const documents = [];
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const sessions = [];
let failed = false;
try {
  for (const [index, name] of ["Presenter", "Viewer"].entries()) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, recordVideo: { dir: join(out, "video"), size: { width: 1440, height: 960 } } });
    await context.addInitScript(webMediaFixture(index + 1));
    const page = await context.newPage();
    if (name === "Presenter")
      page.on("response", (response) => {
        const { pathname } = new URL(response.url());
        if (!pathname.includes("/presenting/documents") || response.request().method() !== "GET") return;
        void response.json().then((body) => documents.push({ path: pathname, status: response.status(), body }), () => undefined);
      });
    await page.goto(new URL(seed.invite.path, web).href);
    await page.getByLabel("Your name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    await page.getByRole("button", { name: "Video tile for " + name, exact: true }).first().waitFor({ timeout: 60_000 });
    sessions.push({ name, page });
  }
  const [presenter, viewer] = sessions;
  for (const { file, expect } of cases) {
    const started = Date.now();
    const before = documents.length;
    try {
      await presenter.page.getByRole("region", { name: "Space stage", exact: true }).hover();
      await presenter.page.getByRole("button", { name: "Share options", exact: true }).click();
      const chooser = presenter.page.waitForEvent("filechooser");
      await presenter.page.getByRole("menuitem", { name: /^(A file|Another file)/ }).click();
      await (await chooser).setFiles(join(dir, file));
      if (expect === "ready") {
        for (const { name, page } of sessions) await page.locator("[data-document-viewer] img").first().waitFor({ timeout: 120_000 });
        await presenter.page.waitForTimeout(1500);
        for (const { name, page } of sessions) await page.screenshot({ path: join(out, "screenshots", name + "-" + file + ".png") });
        steps.push({ name: file + " renders for both people", pass: true, ms: Date.now() - started });
        if (file.endsWith(".xlsx")) {
          const viewerPage = sessions[1].page;
          const pageImage = viewerPage.locator("[data-document-viewer] img").first();
          const fitWidth = await pageImage.evaluate((image) => image.getBoundingClientRect().width);
          for (let step = 0; step < 8; step++) {
            await viewerPage.getByRole("button", { name: "More document options", exact: true }).click();
            await viewerPage.getByRole("menuitem", { name: /^Zoom in/ }).click();
            await viewerPage.waitForTimeout(400);
          }
          await viewerPage.waitForTimeout(1500);
          const zoomed = await pageImage.evaluate((image) => ({ width: image.getBoundingClientRect().width, style: image.style.width, maxWidth: getComputedStyle(image).maxWidth, display: getComputedStyle(image).display, scrollable: image.parentElement.scrollWidth - image.parentElement.clientWidth }));
          await viewerPage.screenshot({ path: join(out, "screenshots", "Viewer-" + file + "-zoomed.png") });
          await pageImage.hover();
          await viewerPage.mouse.wheel(900, 0);
          await viewerPage.waitForTimeout(1500);
          const scrolled = await pageImage.evaluate((image) => image.parentElement.scrollLeft);
          await viewerPage.screenshot({ path: join(out, "screenshots", "Viewer-" + file + "-panned.png") });
          steps.push({ name: file + " zooms and pans for the viewer", pass: zoomed.width > fitWidth * 2 && scrolled > 0, ms: 0, detail: { fitWidth, ...zoomed, scrolled } });
        }
        const stop = presenter.page.getByRole("button", { name: /stop presenting/i }).first();
        if (await stop.count()) await stop.click();
        await presenter.page.waitForTimeout(1500);
      } else {
        const deadline = Date.now() + 90_000;
        let found;
        while (!found && Date.now() < deadline) {
          found = documents.slice(before).find((entry) => entry.body?.failure?.code === expect);
          if (!found) await presenter.page.waitForTimeout(2000);
        }
        await presenter.page.screenshot({ path: join(out, "screenshots", "Presenter-" + file + ".png") });
        const titleStyle = await presenter.page.getByRole("alert").locator("h3").first().evaluate((node) => { const s = getComputedStyle(node); return { wordSpacing: s.wordSpacing, letterSpacing: s.letterSpacing, fontFamily: s.fontFamily, fontKerning: s.fontKerning, whiteSpace: s.whiteSpace, fontWeight: s.fontWeight }; }).catch(() => undefined);
        console.error("TITLE", JSON.stringify(titleStyle));
        const title = (await presenter.page.getByRole("alert").locator("h3").first().textContent({ timeout: 10_000 }).catch(() => "")) ?? "";
        steps.push({ name: file + " fails as " + expect, pass: Boolean(found) && title === "Couldn't open " + file, ms: Date.now() - started, detail: { failure: found?.body?.failure, title } });
        if (!found || title !== "Couldn't open " + file) failed = true;
      }
    } catch (error) {
      failed = true;
      await presenter.page.screenshot({ path: join(out, "screenshots", "Presenter-" + file + "-error.png") }).catch(() => undefined);
      steps.push({ name: file, pass: false, ms: Date.now() - started, detail: String(error.message).slice(0, 400) });
    }
  }
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ steps, documents: documents.map((d) => ({ path: d.path, status: d.status, state: d.body?.status, failure: d.body?.failure, pages: d.body?.pageCount })) }, null, 2));
  for (const { page } of sessions) await page.context().close();
  await browser.close();
}
console.log(JSON.stringify(steps, null, 2));
process.exit(failed || steps.some((s) => !s.pass) ? 1 : 0);
