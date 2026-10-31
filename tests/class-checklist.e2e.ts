import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { webMediaFixture, incomingAudioLevel, audioEvidence } from "../scripts/web-proof/media.mjs";
import { assertAgreement } from "../scripts/web-proof/agreement.mjs";

const output = process.env.CHALK_CLASS_OUTPUT ?? ".private/class-checklist";
const names = ["Teacher", "Student", "Admin"];
const command = promisify(execFile);
const tiles = (page: Page) => page.getByRole("button", { name: /^Video tile for / });
const tile = (page: Page, name: string) => page.getByRole("button", { name: `Video tile for ${name}`, exact: true });

async function checkCase(id: string, check: () => Promise<void>) {
  const start = Date.now();
  try {
    await check();
    await appendFile(`${output}/cases.jsonl`, JSON.stringify({ id, status: "passed", durationMs: Date.now() - start }) + "\n");
  } catch (error) {
    await appendFile(`${output}/cases.jsonl`, JSON.stringify({ id, status: "failed", durationMs: Date.now() - start, error: error instanceof Error ? error.stack : String(error) }) + "\n");
    throw error;
  }
}

async function roster(pages: Page[], timeout = 10_000) {
  for (const page of pages) {
    for (const name of names) await expect.poll(() => tile(page, name).count(), { timeout }).toBe(1);
    await expect.poll(() => tiles(page).count(), { timeout }).toBe(3);
  }
  await assertAgreement(pages);
}

async function join(page: Page, name: string, url: string) {
  await page.bringToFront();
  await page.goto(url);
  await page.getByLabel("Your name", { exact: true }).fill(name);
  const start = Date.now();
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await tile(page, name).waitFor({ timeout: 10_000 });
  expect(Date.now() - start).toBeLessThan(10_000);
}

async function shot(pages: Page[], label: string) {
  for (const [index, page] of pages.entries()) if (!page.isClosed()) await page.screenshot({ path: `${output}/${label}-${names[index]}.png` });
}

function cdpEndpoint(child: ReturnType<typeof spawn>) {
  return new Promise<string>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not expose CDP within 15 seconds")), 15_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited ${code}`));
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
}

async function stopChrome(child: ReturnType<typeof spawn>, profile: string) {
  if (child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(kill);
  }
  await rm(profile, { recursive: true, force: true });
}

async function nativeRole(index: number) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("The class checklist requires disposable Linux/Instabox");
  // noDefaults applies only to the default context. Use one process per role
  // so CDP never forces a hidden student visible or disables timer throttling.
  const profile = await mkdtemp(joinPath(tmpdir(), "chalk-class-"));
  const child = spawn(
    "sudo",
    [
      "-n",
      "setpriv",
      `--reuid=${uid}`,
      `--rgid=${20000 + index}`,
      `--egid=${20000 + index}`,
      "--clear-groups",
      chromium.executablePath(),
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1440,960",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    const browser = await chromium.connectOverCDP(await cdpEndpoint(child), { noDefaults: true });
    const context = browser.contexts()[0];
    context.setDefaultTimeout(15_000);
    await context.addInitScript({ content: webMediaFixture(index % 2) });
    const page = context.pages()[0];
    await page.setViewportSize({ width: 1440, height: 960 });
    return {
      page,
      context,
      async close() {
        try {
          await browser.close();
        } finally {
          await stopChrome(child, profile);
        }
      },
    };
  } catch (error) {
    await stopChrome(child, profile);
    throw error;
  }
}

async function failureProof(pages: Page[], scenario: string) {
  if (scenario === "C5-C6" || scenario === "media-control") {
    const evidence = await Promise.all(pages.map(async (page, index) => ({ role: names[index], ...(await page.evaluate(audioEvidence).catch((cause: unknown) => ({ error: String(cause) }))) })));
    await writeFile(`${output}/${scenario}-audio.json`, JSON.stringify(evidence, null, 2));
  }
  await shot(pages, `${scenario}-failure`);
}

async function classroom(scenario: string, check: (pages: Page[], contexts: BrowserContext[]) => Promise<void>) {
  await mkdir(output, { recursive: true });
  const roles: Awaited<ReturnType<typeof nativeRole>>[] = [];
  const pages: Page[] = [];
  try {
    for (let index = 0; index < names.length; index++) {
      const role = await nativeRole(index);
      roles.push(role);
      pages.push(role.page);
    }
    await join(pages[0], "Teacher", `${process.env.CHALK_PROOF_WEB_URL}/space/`);
    const closeLink = pages[0].getByRole("button", { name: "Close call link", exact: true });
    if (await closeLink.count()) await closeLink.click();
    const url = pages[0].url();
    await join(pages[1], "Student", url);
    await join(pages[2], "Admin", url);
    await roster(pages);
    await shot(pages, `${scenario}-joined`);
    await check(
      pages,
      roles.map((role) => role.context),
    );
  } catch (error) {
    await failureProof(pages, scenario);
    throw error;
  } finally {
    await Promise.all(roles.map((role) => role.close()));
  }
}

async function rejoin(student: Page, pages: Page[]) {
  await student.bringToFront();
  const start = Date.now();
  await student.getByRole("button", { name: "Rejoin", exact: true }).click();
  await roster(pages);
  expect(Date.now() - start).toBeLessThan(10_000);
}

async function chat(sender: Page, receivers: Page[], text: string) {
  await sender.bringToFront();
  const start = Date.now();
  const input = sender.getByRole("textbox", { name: "Message", exact: true });
  if (!(await input.isVisible())) await sender.getByRole("button", { name: "Chat", exact: true }).click();
  await input.fill(text);
  await input.press("Enter");
  for (const page of receivers) {
    await page.bringToFront();
    if (!(await page.getByRole("textbox", { name: "Message", exact: true }).isVisible())) await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByText(text, { exact: true }).waitFor({ timeout: 5000 });
  }
  expect(Date.now() - start).toBeLessThan(5000);
}

async function stroke(page: Page, y: number) {
  await page.bringToFront();
  const board = page.locator(".chalk-board[data-ready]");
  await board.waitFor();
  if (!(await page.getByRole("button", { name: "Pen", exact: true }).isVisible())) await page.getByRole("button", { name: "Drawing tools", exact: true }).click();
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  const box = await board.boundingBox();
  if (!box) throw new Error("Whiteboard has no drawing bounds");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * y, { steps: 15 });
  await page.mouse.up();
}

async function paintedPixels(page: Page) {
  return page
    .locator(".chalk-board canvas")
    .first()
    .evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Whiteboard drawing canvas has no 2D context");
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 32) ink++;
      return ink;
    });
}

async function drop(student: Page, context: BrowserContext, duration: number, pages: Page[]) {
  await student.bringToFront();
  expect(await student.evaluate(() => document.visibilityState)).toBe("visible");
  await context.setOffline(true);
  // C5 models Wi-Fi loss, including established SFU/UDP traffic. Chromium's
  // DevTools offline mode alone does not cut WebRTC. Restrict only this role's
  // process group, retaining loopback CDP so the visible tab remains controllable.
  const rules =
    duration === 140_000
      ? [
          { tool: "iptables", args: ["-m", "owner", "--gid-owner", "20001", "!", "-d", "127.0.0.0/8", "-j", "DROP"] },
          { tool: "ip6tables", args: ["-m", "owner", "--gid-owner", "20001", "!", "-d", "::1/128", "-j", "DROP"] },
          { tool: "iptables", args: ["-m", "owner", "--gid-owner", "20001", "-p", "tcp", "-m", "multiport", "--dports", "3070,8080,4100", "-j", "DROP"] },
        ]
      : [];
  const installed: typeof rules = [];
  try {
    for (const rule of rules) {
      await command("sudo", ["-n", rule.tool, "-I", "OUTPUT", ...rule.args]);
      installed.push(rule);
    }
    await wait(duration);
    expect(await student.evaluate(() => document.visibilityState)).toBe("visible");
    await student.getByRole("heading", { name: "Connection lost", exact: true }).waitFor({ timeout: 1000 });
    expect(await student.getByRole("button", { name: "Rejoin", exact: true }).count()).toBe(1);
    expect(await tiles(student).count()).toBe(0);
    await student.screenshot({ path: `${output}/offline-${duration}.png` });
  } finally {
    for (const rule of installed.reverse()) await command("sudo", ["-n", rule.tool, "-D", "OUTPUT", ...rule.args]);
    await context.setOffline(false);
  }
  await rejoin(student, pages);
}

test("C1: five consecutive joins reach the live call within ten seconds", async () => {
  await checkCase("C1", () =>
    classroom("C1", async (pages) => {
      // The initial entrance is join 1; exercise four more admissions without reload.
      for (let attempt = 2; attempt <= 5; attempt++) {
        await pages[1].bringToFront();
        await pages[1].getByRole("region", { name: "Space stage", exact: true }).hover();
        await pages[1].getByRole("button", { name: "Leave call", exact: true }).click();
        await pages[1].getByRole("button", { name: "Rejoin", exact: true, disabled: false }).waitFor();
        await rejoin(pages[1], pages);
      }
      await shot(pages, "C1");
    }),
  );
});

async function muteStudent(student: Page) {
  await student.bringToFront();
  const mute = student.getByRole("button", { name: "Mute microphone", exact: true });
  if (await mute.count()) await mute.click();
  const camera = student.getByRole("button", { name: "Turn off camera", exact: true });
  if (await camera.count()) await camera.click();
}

test("C2/C7 slow: eight minutes hidden, roster retained, board and chat catch up", async () => {
  await classroom("C2-C7", async (pages, contexts) => {
    const [teacher, student] = pages;
    await muteStudent(student);
    await teacher.bringToFront();
    await teacher.getByRole("button", { name: "Board", exact: true }).click();
    await teacher.locator(".chalk-board[data-ready]").waitFor();
    await student.bringToFront();
    await student.locator(".chalk-board[data-ready]").waitFor();
    const cover = await contexts[1].newPage();
    await cover.bringToFront();
    expect(await student.evaluate(() => document.visibilityState)).toBe("hidden");
    for (const page of pages)
      await page.evaluate(() => {
        const root = document.documentElement;
        root.dataset.classRosterLost = "false";
        root.dataset.classForegrounded = "false";
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") root.dataset.classForegrounded = "true";
        });
        new MutationObserver(() => {
          const labels = [...document.querySelectorAll('button[aria-label^="Video tile for "]')].map((button) => button.getAttribute("aria-label"));
          if (["Teacher", "Student", "Admin"].some((name) => !labels.includes(`Video tile for ${name}`))) root.dataset.classRosterLost = "true";
        }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] });
      });
    const failures = [];
    await checkCase("C2", async () => {
      // Wall time is essential: intensive background timer throttling starts after five minutes.
      await wait(360_000);
      await stroke(teacher, 0.35);
      await wait(120_000);
      expect(await student.evaluate(() => document.visibilityState)).toBe("hidden");
      expect(await student.locator("html").getAttribute("data-class-foregrounded")).toBe("false");
      for (const page of pages) expect(await page.locator("html").getAttribute("data-class-roster-lost")).toBe("false");
      await roster(pages);
      await shot(pages, "C2-hidden");
    }).catch((error: unknown) => failures.push(error));
    await checkCase("C7", async () => {
      await cover.close();
      const shown = Date.now();
      await student.bringToFront();
      await expect.poll(() => student.locator(".chalk-board").getAttribute("data-elements"), { timeout: 10_000 }).toBe("1");
      await expect.poll(() => paintedPixels(student), { timeout: 10_000 }).toBeGreaterThan(0);
      expect(Date.now() - shown).toBeLessThan(10_000);
      const before = await paintedPixels(student);
      await stroke(teacher, 0.65);
      const drawn = Date.now();
      await student.bringToFront();
      await expect.poll(() => student.locator(".chalk-board").getAttribute("data-elements"), { timeout: 5000 }).toBe("2");
      await expect.poll(() => paintedPixels(student), { timeout: 5000 }).toBeGreaterThan(before + 10);
      expect(Date.now() - drawn).toBeLessThan(5000);
      await chat(student, pages, "C7 student chat after eight minutes hidden");
      await roster(pages);
      await shot(pages, "C7");
    }).catch((error: unknown) => failures.push(error));
    if (failures.length) throw new AggregateError(failures, "Background checklist failed");
  });
});

test("C3 slow: close the student tab for three minutes then join a fresh tab", async () => {
  await checkCase("C3", () =>
    classroom("C3", async (pages, contexts) => {
      const url = pages[1].url();
      // Closing the last tab exits a native Chromium process. Keep the browser
      // alive like a real desktop with other tabs; this page never joins Chalk.
      const empty = await contexts[1].newPage();
      await pages[1].close();
      await wait(180_000);
      pages[1] = await contexts[1].newPage();
      await pages[1].bringToFront();
      const start = Date.now();
      // The saved entrance automatically rejoins when this browser reopens the URL.
      await pages[1].goto(url);
      await tile(pages[1], "Student").waitFor({ timeout: 10_000 });
      await roster(pages);
      expect(Date.now() - start).toBeLessThan(10_000);
      await empty.close();
      await shot(pages, "C3");
    }),
  );
});

test("C4 slow: sixty seconds offline then one Rejoin", async () => {
  await classroom("C4", async (pages, contexts) => {
    await checkCase("C4", async () => {
      await drop(pages[1], contexts[1], 60_000, pages);
      await shot(pages, "C4");
    });
  });
});

async function enableMedia(pages: Page[]) {
  for (const page of pages.slice(0, 2)) {
    await page.bringToFront();
    await page.getByRole("button", { name: "Unmute microphone", exact: true }).click();
    await assertAgreement(pages);
    await page.getByRole("button", { name: "Turn on camera", exact: true }).click();
    await assertAgreement(pages);
  }
}

async function advancingFrames(video: Locator) {
  const frames = () => video.evaluate((element: HTMLVideoElement) => element.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(frames, { timeout: 10_000 }).toBeGreaterThan(5);
  const before = await frames();
  await expect.poll(frames, { timeout: 5000 }).toBeGreaterThan(before + 5);
}

async function receivedMedia(pages: Page[]) {
  await assertAgreement(pages);
  for (const [page, remote] of [
    [pages[0], "Student"],
    [pages[1], "Teacher"],
  ] satisfies [Page, string][]) {
    await page.bringToFront();
    await expect.poll(() => page.evaluate(incomingAudioLevel), { timeout: 10_000 }).toBeGreaterThan(0);
    const video = page
      .locator('[data-part="stage-tile"]')
      .filter({ has: tile(page, remote) })
      .locator("video");
    await advancingFrames(video);
  }
}

async function recoveredMedia(pages: Page[]) {
  await enableMedia(pages);
  await receivedMedia(pages);
  // Deterministic moving display source, captured and transported by the real SDK/SFU.
  await pages[0].evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No 2D display capture context");
      let frame = 0;
      const timer = setInterval(() => {
        context.fillStyle = `hsl(${frame++ % 360} 80% 50%)`;
        context.fillRect(0, 0, 640, 360);
      }, 66);
      const stream = canvas.captureStream(15);
      stream.getVideoTracks()[0].addEventListener("ended", () => clearInterval(timer), { once: true });
      return stream;
    };
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await pages[0].bringToFront();
    const start = Date.now();
    await pages[0].getByRole("button", { name: "Share screen", exact: true }).click();
    for (const page of pages.slice(1)) {
      await page.bringToFront();
      const video = page.locator('[data-stage-item^="screen"] video');
      await video.waitFor({ timeout: 10_000 });
      await advancingFrames(video);
    }
    expect(Date.now() - start).toBeLessThan(10_000);
    await shot(pages, `C6-share-${attempt}`);
    await pages[0].bringToFront();
    await pages[0].getByRole("button", { name: "Stop sharing", exact: true }).click();
    for (const page of pages.slice(1)) await page.locator('[data-stage-item^="screen"]').waitFor({ state: "detached" });
  }
  await roster(pages);
}

test("Media control: fresh native browsers receive both directions and restarted share", async () => {
  await classroom("media-control", recoveredMedia);
});

test("C5/C6 slow: visible 140-second drop, one Rejoin, live media and restarted share", async () => {
  await classroom("C5-C6", async (pages, contexts) => {
    await checkCase("C5", async () => {
      await drop(pages[1], contexts[1], 140_000, pages);
      await chat(pages[1], pages, "C5 chat after 140 seconds offline");
      await roster(pages);
      await shot(pages, "C5");
    });
    await checkCase("C6", () => recoveredMedia(pages));
  });
});
