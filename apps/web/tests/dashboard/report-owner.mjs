import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { received, submit } from "./report-support.mjs";

export async function homeChecks(c) {
  const { page, origin, call, evidence } = c;
  const home = await page.context().newPage();
  try {
    await home.goto(`${origin}/dashboard`);
    await home.getByRole("button", { name: `More actions for ${call.call.name}`, exact: true }).click();
    await home.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const input = home.getByRole("dialog").getByLabel("Name", { exact: true });
    const name = "🎥".repeat(119) + "🏁";
    await input.fill(name);
    await home.screenshot({ path: resolve(evidence, "unicode-name-input.png"), animations: "disabled" });
    assert.equal(await input.inputValue(), name, "The dashboard must preserve a 120-code-point emoji name and its suffix");
    await input.fill(name + "extra");
    assert.equal(await input.inputValue(), name, "The input must cap by code points, without losing its suffix");
    await input.fill("extra" + name);
    assert.equal(await input.inputValue(), name, "An insertion at the limit must not discard the identifying suffix");
    const saved = home.waitForResponse((response) => response.url().endsWith("/dashboard-api/home") && response.request().method() === "POST");
    await home.getByRole("button", { name: "Save name", exact: true }).click();
    const response = await saved;
    assert.equal(response.status(), 200);
    const renamed = await response.json();
    assert.equal(renamed.call.name, name, "Dashboard and API must accept the complete supported name");
    await home.getByRole("dialog").waitFor({ state: "hidden" });
    call.call.name = name;
  } finally {
    await home.close();
  }
}

export async function ownerReport(c) {
  const { page, evidence } = c;
  await page.getByRole("button", { name: "Call details", exact: true }).first().click();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).waitFor();
  await page.screenshot({ path: resolve(evidence, "owner-dropdown.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Report a problem", exact: true }).click({ timeout: 10000 });
  await submit(c, page, { name: "owner", failure: process.env.CHALK_REPORT_LIVE_PROOF !== "1" });
  assert((await received(c)).at(-1).content.includes("(owner)"));
  const ownerFocusRestored = await page
    .waitForFunction(() => document.activeElement?.matches('button[data-part="call-name"]') && document.activeElement.isConnected, undefined, { timeout: 3000 })
    .then(
      () => true,
      () => false,
    );
  await page.screenshot({ path: resolve(evidence, "owner-report-focus.png"), animations: "disabled" });
  await writeFile(resolve(evidence, "owner-focus-regression.json"), JSON.stringify({ passed: ownerFocusRestored }, null, 2));
  assert(ownerFocusRestored, "Closing the SDK-owned report must focus its persistent Call Details trigger");
}

export async function policyChecks(c) {
  const { page, origin, evidence } = c;
  const policy = await page.context().newPage();
  try {
    await policy.goto(`${origin}/privacy`);
    const disclosure = policy.getByRole("listitem").filter({ hasText: "Discord" });
    await disclosure.waitFor();
    const text = await disclosure.innerText();
    for (const field of ["what you type", "display name and role", "Space name and Episode ID", "If you choose to include diagnostics", "We do not add your account email address"]) assert(text.includes(field), field);
    assert((await policy.locator("body").innerText()).includes("Discord relies on the EU-US Data Privacy Framework adequacy decision"));
    await disclosure.scrollIntoViewIfNeeded();
    await policy.screenshot({ path: resolve(evidence, "privacy-disclosure.png"), animations: "disabled" });
  } finally {
    await policy.close();
  }
}

export async function expiredOwner(c) {
  const { browser, page, origin, evidence } = c;
  // Clock installation affects its whole context; keep the reload journey on real time.
  const failedOwnerContext = await browser.newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 1440, height: 960 },
    ...(process.env.CHALK_REPORT_VIDEO === "1" ? { recordVideo: { dir: resolve(evidence, "videos"), size: { width: 1440, height: 960 } } } : {}),
  });
  const failedOwner = await failedOwnerContext.newPage();
  try {
    await failedOwner.clock.install();
    let interceptedOwnerSync = 0;
    await failedOwner.routeWebSocket(/\/v1\/sync(?:\?|$)/, (socket) => {
      interceptedOwnerSync++;
      socket.onMessage(() => {});
    });
    await failedOwner.goto(`${origin}/dashboard`);
    await failedOwner.getByRole("button", { name: "Start a call", exact: true }).first().click();
    await failedOwner.getByRole("button", { name: "Join call", exact: true }).click();
    await failedOwner.getByText(/Could(?: not|n’t) connect to/).waitFor({ timeout: 45000 });
    assert(interceptedOwnerSync > 0, "Owner failure must follow a real admission and intercepted Sync connection");
    await failedOwner.getByRole("button", { name: "Report a problem", exact: true }).waitFor();
    await failedOwner.screenshot({ path: resolve(evidence, "owner-before-expiry.png"), animations: "disabled" });
    await failedOwner.clock.fastForward(301_000);
    await failedOwner.screenshot({ path: resolve(evidence, "owner-after-expiry.png"), animations: "disabled" });
    assert.equal(await failedOwner.getByRole("button", { name: "Report a problem", exact: true }).count(), 0, "Expired owner reporting must disappear after the five-minute credential lifetime");
  } finally {
    await failedOwnerContext.close();
  }
}
