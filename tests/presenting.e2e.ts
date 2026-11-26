import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import ports from "../scripts/dev/ports.json";
import { webMediaFixture } from "../scripts/web-proof/media.mjs";

const execFileAsync = promisify(execFile);

const webSpaceUrl = () => new URL("/space/", process.env.CHALK_PROOF_WEB_URL ?? `http://127.0.0.1:${ports.web}`).href;
const primaryDocument = (page: Page) => page.locator('[data-stage-item^="document:"][data-stage-role="primary"]');

async function joinTwo(contexts: BrowserContext[]): Promise<[Page, Page]> {
  const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
  await a.goto(webSpaceUrl());
  await a.getByLabel("Your name", { exact: true }).fill("Nora");
  await a.getByRole("button", { name: "Join call", exact: true }).click();
  await a.getByRole("button", { name: "Video tile for Nora", exact: true }).waitFor();
  const details = a.getByRole("dialog", { name: "Call details", exact: true });
  if (await details.isVisible()) await details.getByRole("button", { name: "Close", exact: true }).click();
  await b.goto(a.url());
  await b.getByLabel("Your name", { exact: true }).fill("Malik");
  await b.getByRole("button", { name: "Join call", exact: true }).click();
  for (const page of [a, b]) {
    await page.getByRole("button", { name: "Video tile for Nora", exact: true }).waitFor();
    await page.getByRole("button", { name: "Video tile for Malik", exact: true }).waitFor();
  }
  return [a, b];
}

test("one person presents a PDF and it lands on both stages", async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    for (const context of contexts) await context.addInitScript(webMediaFixture(1, { permission: "granted" }));
    const [a, b] = await joinTwo(contexts);

    // The Present dock button is its own control beside screen share.
    const present = a.getByRole("button", { name: "Present", exact: true });
    await present.waitFor();
    await present.click();
    const chooser = a.getByRole("dialog", { name: "Present a file or link", exact: true });
    await chooser.waitFor();

    const [fileChooser] = await Promise.all([a.waitForEvent("filechooser"), chooser.getByRole("button", { name: /Choose a file|Preparing/ }).click()]);
    const pdf = await readFile(new URL("../apps/document-renderer/testdata/normal.pdf", import.meta.url));
    await fileChooser.setFiles({ name: "product-plan.pdf", mimeType: "application/pdf", buffer: pdf });

    // Both stages gain the document item and then render its first page.
    for (const page of [a, b]) {
      await expect.poll(() => primaryDocument(page).count(), { timeout: 15_000 }).toBe(1);
      const image = primaryDocument(page).locator("[data-document-viewer] img").first();
      await image.waitFor({ timeout: 30_000 });
      await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0), { timeout: 10_000 }).toBe(true);
    }

    // The presenter controls the ready document, and a turn synchronizes the indicator.
    const stop = a.getByRole("button", { name: "Stop showing", exact: true });
    await stop.waitFor();
    await primaryDocument(a).getByText("Page 1 of 2", { exact: true }).waitFor({ timeout: 10_000 });
    await primaryDocument(a).getByRole("button", { name: "Next page", exact: true }).click();
    await primaryDocument(a).getByText("Page 2 of 2", { exact: true }).waitFor({ timeout: 10_000 });
    await primaryDocument(b).getByText("Page 2 of 2", { exact: true }).waitFor({ timeout: 10_000 });

    // The viewer's copy is the same document, so the presenter stopping removes it everywhere.
    await stop.click();
    for (const page of [a, b]) await expect.poll(() => page.locator('[data-stage-item^="document:"]').count(), { timeout: 10_000 }).toBe(0);
  } finally {
    await browser?.close();
  }
});

function presentingDatabase(): string {
  return process.env.CHALK_DATABASE_URL ?? `postgres://postgres:postgres@127.0.0.1:${ports.postgres}/chalk_dev?sslmode=disable`;
}

async function presentingEnabled(enabled: boolean): Promise<void> {
  await execFileAsync("psql", [presentingDatabase(), "-v", "ON_ERROR_STOP=1", "-q", "-c", `insert into presenting_settings (singleton, enabled) values (true, ${enabled}) on conflict (singleton) do update set enabled = excluded.enabled`]);
}

async function presentingSetting(): Promise<boolean | null> {
  const { stdout } = await execFileAsync("psql", [presentingDatabase(), "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", "-c", "select coalesce((select enabled::text from presenting_settings where singleton), 'missing')"]);
  const value = String(stdout).trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "missing") return null;
  throw new Error(`Unexpected presenting setting: ${value}`);
}

async function restorePresentingSetting(setting: boolean | null): Promise<void> {
  if (setting !== null) return presentingEnabled(setting);
  await execFileAsync("psql", [presentingDatabase(), "-v", "ON_ERROR_STOP=1", "-q", "-c", "delete from presenting_settings where singleton"]);
}

test("the Present button is hidden when Sync does not offer Presenting", async () => {
  const original = await presentingSetting();
  let browser: Browser | undefined;
  try {
    await presentingEnabled(false);
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addInitScript(webMediaFixture(1, { permission: "granted" }));
    const page = await context.newPage();
    await page.goto(webSpaceUrl());
    await page.getByLabel("Your name", { exact: true }).fill("Nora");
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    await page.getByRole("button", { name: "Video tile for Nora", exact: true }).waitFor();
    await expect.poll(async () => page.getByRole("button", { name: "Present", exact: true }).count(), { timeout: 5_000 }).toBe(0);
  } finally {
    try {
      await browser?.close();
    } finally {
      await restorePresentingSetting(original);
    }
  }
});
