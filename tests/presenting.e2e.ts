// fallow-ignore-file complexity -- one end-to-end journey; its steps run in order across two browser sessions, so splitting it would hide the flow it proves.
import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ports from "../scripts/dev/ports.json";
import { webMediaFixture } from "../scripts/web-proof/media.mjs";

const execFileAsync = promisify(execFile);

/** A minimal one-page PDF the chat attachment pipeline accepts. */
const PDF_BYTES = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
trailer<</Size 4/Root 1 0 R>>
startxref
156
%%EOF`;

async function joinTwo(contexts: BrowserContext[]): Promise<[Page, Page]> {
  const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
  await a.goto(new URL("/space/", process.env.CHALK_PROOF_WEB_URL ?? `http://localhost:${ports.web}`).href);
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
  const browser = await chromium.launch();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  for (const context of contexts) await context.addInitScript(webMediaFixture(1, { permission: "granted" }));
  try {
    const [a, b] = await joinTwo(contexts);

    // Presenting a file lives in the Share menu, and its entry opens the file picker.
    await a.getByRole("button", { name: "Share options", exact: true }).click();
    const [fileChooser] = await Promise.all([a.waitForEvent("filechooser"), a.getByRole("menuitem", { name: /^A file/ }).click()]);
    await fileChooser.setFiles({ name: "product-plan.pdf", mimeType: "application/pdf", buffer: Buffer.from(PDF_BYTES) });

    // Both stages gain the document item: the presenter sees their tile, the viewer the same document.
    for (const page of [a, b]) {
      await expect.poll(async () => page.locator('[data-stage-item^="document:"]').count(), { timeout: 15_000 }).toBe(1);
    }
    await expect.poll(() => a.locator('[data-stage-item^="document:"][data-stage-role="primary"]').count(), { timeout: 10_000 }).toBe(1);

    // Until the renderer finishes, the tile explains the document is being prepared.
    await expect.poll(async () => (await a.locator('[data-stage-item^="document:"]').textContent()) ?? "", { timeout: 10_000 }).toContain("product-plan.pdf");

    // The viewer's copy is the same document, so the presenter stopping removes it everywhere.
    const stop = a.getByRole("button", { name: "Stop showing", exact: true });
    if (await stop.isVisible().catch(() => false)) {
      await stop.click();
      for (const page of [a, b]) await expect.poll(() => page.locator('[data-stage-item^="document:"]').count(), { timeout: 10_000 }).toBe(0);
    }
  } finally {
    await browser.close();
  }
});

async function presentingEnabled(enabled: boolean): Promise<void> {
  const database = process.env.CHALK_DATABASE_URL ?? `postgres://postgres:postgres@127.0.0.1:${ports.postgres}/chalk_dev?sslmode=disable`;
  await execFileAsync("psql", [database, "-v", "ON_ERROR_STOP=1", "-q", "-c", `insert into presenting_settings (singleton, enabled) values (true, ${enabled}) on conflict (singleton) do update set enabled = excluded.enabled`]);
}

test("Present a file is hidden from the Share menu when Sync does not offer Presenting", async () => {
  await presentingEnabled(false);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addInitScript(webMediaFixture(1, { permission: "granted" }));
    const page = await context.newPage();
    await page.goto(new URL("/space/", process.env.CHALK_PROOF_WEB_URL ?? `http://localhost:${ports.web}`).href);
    await page.getByLabel("Your name", { exact: true }).fill("Nora");
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    await page.getByRole("button", { name: "Video tile for Nora", exact: true }).waitFor();
    await page.getByRole("button", { name: "Share options", exact: true }).click();
    await page.getByRole("menu").waitFor();
    await expect.poll(async () => page.getByRole("menuitem", { name: /^(A|Another) file/ }).count(), { timeout: 5_000 }).toBe(0);
  } finally {
    await browser?.close();
    await presentingEnabled(true);
  }
});
