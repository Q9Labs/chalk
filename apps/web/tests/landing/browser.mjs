import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const proof = process.env.LANDING_PROOF_DIR;
const browser = await chromium.launch({ headless: true });
if (proof) await mkdir(proof, { recursive: true });

async function start(channel) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve) => reservation.close(resolve));
  const runner = `
    import { spawn } from 'node:child_process';
    const stop = () => process.kill(-process.pid, 'SIGTERM');
    process.stdin.resume(); process.stdin.once('end', stop);
    setTimeout(stop, 180000).unref();
    const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', process.argv[1], '--strictPort'], { stdio: 'inherit' });
    vite.once('error', stop); vite.once('exit', stop);
  `;
  const server = spawn(process.execPath, ["--input-type=module", "-e", runner, String(address.port)], {
    cwd: webRoot,
    detached: true,
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, CHALK_DEV_WEB_PORT: String(address.port), VITE_PUBLIC_APP_URL: `https://${channel === "nightly" ? "nightly." : ""}chalkmeet.com` },
  });
  let errors = "";
  server.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-4000);
  });
  const exit = once(server, "exit");
  const origin = `http://127.0.0.1:${address.port}`;
  const stop = async () => {
    server.stdin.end();
    await exit;
  };
  try {
    for (let attempt = 0; attempt < 90; attempt++) {
      assert(server.exitCode === null, `Vite exited: ${errors}`);
      if (
        await fetch(origin, { signal: AbortSignal.timeout(1000) }).then(
          (r) => r.ok,
          () => false,
        )
      )
        return { origin, stop };
      await delay(500);
    }
    throw new Error(`Landing server did not start: ${errors}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

try {
  for (const channel of ["stable", "nightly"]) {
    const { origin, stop } = await start(channel);
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      const preview = page.getByRole("group", { name: "Interactive Q9 team call preview" });
      await preview.getByRole("button", { name: "Mute microphone", exact: true }).click();
      assert.equal(await preview.getByRole("button", { name: "Unmute microphone", exact: true }).getAttribute("aria-pressed"), "false");
      await preview.getByRole("button", { name: "Turn camera off", exact: true }).click();
      assert.equal(await preview.locator('.xtile[data-cam="false"]').count(), 2);
      for (const name of ["Share screen", "Raise hand", "Toggle preview light theme"]) {
        await preview.getByRole("button", { name, exact: true }).click();
        assert.equal(await preview.getByRole("button", { name, exact: true }).getAttribute("aria-pressed"), "true");
      }
      await preview.getByRole("button", { name: "Open preview chat", exact: true }).click();
      await preview.getByRole("textbox", { name: "Message the preview call" }).fill("Friday works for me too.");
      await preview.getByRole("button", { name: "Send preview message" }).click();
      assert.match(await preview.getByRole("log").textContent(), /Friday works for me too/);
      await preview.getByRole("button", { name: "Leave preview call" }).click();
      await preview.getByRole("button", { name: "Rejoin" }).click();
      await preview.getByRole("button", { name: "Close preview chat" }).click();
      await page.getByRole("button", { name: "Recorded 5", exact: true }).click();
      assert.equal(await page.locator(".sx-row").count(), 5);
      await page.getByRole("button", { name: "All 7", exact: true }).click();
      assert.equal(await page.locator(".sx-row").count(), 7);
      await page.locator(".sx-row").first().click();
      assert.equal(await page.locator(".sx-row").first().getAttribute("aria-expanded"), "true");
      await page.getByRole("button", { name: "Seek recording to 01:32: Sofia Lind", exact: true }).click();
      assert.match(await page.locator(".mp-t").textContent(), /^01:3/);
      await page.locator(".mplay").click();
      await page.getByRole("button", { name: "Server", exact: true }).click();
      await page.getByRole("button", { name: "Copy code", exact: true }).click();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /createChalkServerClient/);
      await page.getByRole("button", { name: "React", exact: true }).click();
      await page.locator(".js-go").click();
      await page.getByRole("button", { name: "Replay", exact: true }).waitFor();
      assert.equal(await page.locator(".js-t").textContent(), "0.84 s");
      await page.getByRole("button", { name: "Join", exact: true }).first().click();
      assert.match(await page.getByRole("alert").textContent(), /isn’t a Chalk link/);
      assert.equal(await page.locator(".hvis.sky").count(), channel === "nightly" ? 1 : 0);
      const host = page.locator(".host");
      await host.getByRole("button", { name: "Raise hand", exact: true }).click();
      assert.equal(await host.locator('.xtile[data-hand="true"]').count(), 1);
      // Reset demonstration states before the eight visual snapshots.
      await page.reload();
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        for (const theme of ["dark", "light"]) {
          const toggle = page.getByRole("button", { name: `Switch to ${theme} theme`, exact: true });
          if (await toggle.count()) await toggle.click();
          assert.equal(await page.locator(".site").getAttribute("data-chalk-theme"), theme);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
          const mic = preview.getByRole("button", { name: "Mute microphone", exact: true });
          const box = await mic.boundingBox();
          assert(box && box.width >= 44 && box.height >= 44);
          const speaker = await preview.locator(".spk .xtag").textContent();
          await page.waitForTimeout(3100);
          assert.equal(await preview.locator(".spk .xtag").textContent(), speaker);
          if (proof) await page.screenshot({ path: resolve(proof, `${channel}-${theme}-${width}.png`), fullPage: true });
        }
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${channel}: pointer controls, chat, leave/rejoin, filter/expand, transcript seek, copied tab, simulator, join validation, host preview, both themes/widths, reduced motion`);
    } finally {
      await context.close();
      await stop();
    }
  }
} finally {
  await browser.close();
}
