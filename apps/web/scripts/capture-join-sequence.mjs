#!/usr/bin/env node
// Captures the real joining -> live reveal at fixed CSS-transition times.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values } = parseArgs({ options: { out: { type: "string" }, port: { type: "string", default: "3072" } } });
if (!values.out) throw new Error("Pass --out <folder>.");
const out = resolve(values.out);
const origin = `http://127.0.0.1:${values.port}`;
const server = spawn("pnpm", ["exec", "vite", "--config", "vite.call-states.config.ts", "--port", values.port], { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "ignore", "inherit"], detached: true });
// Independent watchdog survives owner loss, including SIGKILL, and bounds the server lifetime.
const watchdog = spawn(
  process.execPath,
  [
    "-e",
    `
  const owner = Number(process.argv[1]);
  const server = Number(process.argv[2]);
  const deadline = Date.now() + 120_000;
  setInterval(() => {
    let alive = true;
    try { process.kill(owner, 0); } catch { alive = false; }
    if (alive && Date.now() < deadline) return;
    try { process.kill(-server, "SIGTERM"); } catch {}
    process.exit();
  }, 1000);
`,
    String(process.pid),
    String(server.pid),
  ],
  { detached: true, stdio: "ignore" },
);
watchdog.unref();
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${origin}/call-states.html`)).ok) break;
    } catch {
      /* Server starting. */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const proof = [];
  for (const [size, viewport] of Object.entries({ laptop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } })) {
    const context = await browser.newContext({ viewport, reducedMotion: "no-preference" });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/call-states.html?state=joining-complete`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForSelector("[data-complete-join]", { state: "attached" });
      await mkdir(join(out, size), { recursive: true });
      await page.locator("[data-complete-join]").evaluate((button) => button.click());
      // Freeze the actual CSS transitions; screenshots no longer depend on PNG encoding latency.
      await page.waitForFunction(() => document.getAnimations().some((animation) => animation.transitionProperty === "backdrop-filter"));
      await page.evaluate(() => {
        window.joinTransitions = document.getAnimations();
        for (const animation of window.joinTransitions) animation.pause();
      });
      for (const ms of [0, 150, 300, 500]) {
        await page.evaluate((time) => {
          for (const animation of window.joinTransitions) animation.currentTime = time;
        }, ms);
        const styles = await page
          .locator("[data-call-limbo]")
          .last()
          .evaluate((element) => ({ blur: getComputedStyle(element).backdropFilter, background: getComputedStyle(element).backgroundColor }));
        proof.push({ size, ms, ...styles });
        await page.screenshot({ path: join(out, size, `join-lift-${ms}.png`), animations: "allow" });
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.reload();
      await page.locator("[data-complete-join]").evaluate((button) => button.click());
      const transition = await page
        .locator("[data-call-limbo]")
        .last()
        .evaluate((element) => getComputedStyle(element).transitionProperty);
      if (transition !== "opacity") throw new Error(`Reduced motion animates ${transition}, expected opacity.`);
      proof.push({ size, reducedMotion: transition });
    } finally {
      await context.close();
    }
  }
  await writeFile(join(out, "sequence-proof.json"), JSON.stringify(proof, null, 2));
} finally {
  watchdog.kill("SIGTERM");
  await browser?.close();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
