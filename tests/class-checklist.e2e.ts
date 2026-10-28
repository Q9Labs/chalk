import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { webMediaFixture, incomingAudioLevel } from "../scripts/web-proof/media.mjs";

const output = process.env.CHALK_CLASS_OUTPUT ?? ".private/class-checklist";
const names = ["Teacher", "Student", "Admin"];
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
}

async function join(page: Page, name: string, url: string) {
  await page.goto(url);
  await page.getByLabel("Your name", { exact: true }).fill(name);
  const start = Date.now();
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await tile(page, name).waitFor({ timeout: 10_000 });
  expect(Date.now() - start).toBeLessThan(10_000);
}

async function shot(pages: Page[], label: string) {
  for (const [index, page] of pages.entries()) await page.screenshot({ path: `${output}/${label}-${names[index]}.png` });
}

async function classroom(check: (pages: Page[], contexts: BrowserContext[]) => Promise<void>) {
  await mkdir(output, { recursive: true });
  const browsers: Browser[] = [];
  const processes: ReturnType<typeof spawn>[] = [];
  const profiles: string[] = [];
  const pages: Page[] = [];
  try {
    const contexts: BrowserContext[] = [];
    for (let index = 0; index < names.length; index++) {
      // noDefaults applies only to the default context. Use one process per role
      // so CDP never forces a hidden student visible or disables timer throttling.
      const profile = await mkdtemp(joinPath(tmpdir(), "chalk-class-"));
      profiles.push(profile);
      const process = spawn(chromium.executablePath(), ["--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1440,960", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
      processes.push(process);
      const endpoint = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        const timer = setTimeout(() => reject(new Error("Chromium did not expose CDP within 15 seconds")), 15_000);
        process.once("error", reject);
        process.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Chromium exited ${code}`));
        });
        process.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
      });
      const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
      browsers.push(browser);
      const context = browser.contexts()[0];
      context.setDefaultTimeout(15_000);
      await context.addInitScript({ content: webMediaFixture(index % 2) });
      contexts.push(context);
      const page = context.pages()[0];
      await page.setViewportSize({ width: 1440, height: 960 });
      pages.push(page);
    }
    await join(pages[0], "Teacher", `${process.env.CHALK_PROOF_WEB_URL}/space/`);
    const closeLink = pages[0].getByRole("button", { name: "Close call link", exact: true });
    if (await closeLink.count()) await closeLink.click();
    const url = pages[0].url();
    await join(pages[1], "Student", url);
    await join(pages[2], "Admin", url);
    await roster(pages);
    await shot(pages, "joined");
    await check(pages, contexts);
  } catch (error) {
    await shot(
      pages.filter((page) => !page.isClosed()),
      "failure",
    );
    throw error;
  } finally {
    await Promise.all(browsers.map((browser) => browser.close()));
    for (const process of processes) {
      if (process.exitCode === null) {
        const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
        process.kill("SIGTERM");
        const kill = setTimeout(() => process.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(kill);
      }
    }
    for (const profile of profiles) await rm(profile, { recursive: true, force: true });
  }
}

async function rejoin(student: Page, pages: Page[]) {
  const start = Date.now();
  await student.getByRole("button", { name: "Rejoin", exact: true }).click();
  await roster(pages);
  expect(Date.now() - start).toBeLessThan(10_000);
}

async function chat(sender: Page, receivers: Page[], text: string) {
  const input = sender.getByRole("textbox", { name: "Message", exact: true });
  if (!(await input.isVisible())) await sender.getByRole("button", { name: "Chat", exact: true }).click();
  await input.fill(text);
  await input.press("Enter");
  for (const page of receivers) {
    if (!(await page.getByRole("textbox", { name: "Message", exact: true }).isVisible())) await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByText(text, { exact: true }).waitFor({ timeout: 5000 });
  }
}

async function stroke(page: Page, y: number) {
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

async function drop(student: Page, context: BrowserContext, duration: number, pages: Page[]) {
  await student.bringToFront();
  expect(await student.evaluate(() => document.visibilityState)).toBe("visible");
  await context.setOffline(true);
  try {
    await wait(duration);
    await student.getByRole("heading", { name: "Connection lost", exact: true }).waitFor({ timeout: 1000 });
    expect(await student.getByRole("button", { name: "Rejoin", exact: true }).count()).toBe(1);
    expect(await tiles(student).count()).toBe(0);
    await student.screenshot({ path: `${output}/offline-${duration}.png` });
  } finally {
    await context.setOffline(false);
  }
  await rejoin(student, pages);
}

test("C1: five consecutive joins reach the live call within ten seconds", async () => {
  await checkCase("C1", () =>
    classroom(async (pages) => {
      // The initial entrance is join 1; exercise four more admissions without reload.
      for (let attempt = 2; attempt <= 5; attempt++) {
        await pages[1].getByRole("region", { name: "Space stage", exact: true }).hover();
        await pages[1].getByRole("button", { name: "Leave call", exact: true }).click();
        await pages[1].getByRole("button", { name: "Rejoin", exact: true, disabled: false }).waitFor();
        await rejoin(pages[1], pages);
      }
      await shot(pages, "C1");
    }),
  );
});

test("C2/C7 slow: eight minutes hidden, roster retained, board and chat catch up", async () => {
  await classroom(async (pages, contexts) => {
    const [teacher, student] = pages;
    const mute = student.getByRole("button", { name: "Mute microphone", exact: true });
    if (await mute.count()) await mute.click();
    const camera = student.getByRole("button", { name: "Turn off camera", exact: true });
    if (await camera.count()) await camera.click();
    await teacher.getByRole("button", { name: "Board", exact: true }).click();
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
      await student.bringToFront();
      await expect.poll(() => student.locator(".chalk-board").getAttribute("data-elements"), { timeout: 10_000 }).toBe("1");
      await stroke(teacher, 0.65);
      await expect.poll(() => student.locator(".chalk-board").getAttribute("data-elements"), { timeout: 5000 }).toBe("2");
      await chat(student, pages, "C7 student chat after eight minutes hidden");
      await roster(pages);
      await shot(pages, "C7");
    }).catch((error: unknown) => failures.push(error));
    if (failures.length) throw new AggregateError(failures, "Background checklist failed");
  });
});

test("C3 slow: close the student tab for three minutes then join a fresh tab", async () => {
  await checkCase("C3", () =>
    classroom(async (pages, contexts) => {
      const url = pages[1].url();
      await pages[1].close();
      await wait(180_000);
      pages[1] = await contexts[1].newPage();
      await join(pages[1], "Student", url);
      await roster(pages);
      await shot(pages, "C3");
    }),
  );
});

test("C4/C6 slow: sixty seconds offline, one Rejoin, live two-way media and restarted share", async () => {
  await classroom(async (pages, contexts) => {
    await checkCase("C4", async () => {
      await drop(pages[1], contexts[1], 60_000, pages);
      await shot(pages, "C4");
    });
    await checkCase("C6", async () => {
      for (const page of pages.slice(0, 2)) {
        await page.getByRole("button", { name: "Unmute microphone", exact: true }).click();
        await page.getByRole("button", { name: "Turn on camera", exact: true }).click();
      }
      for (const [page, remote] of [
        [pages[0], "Student"],
        [pages[1], "Teacher"],
      ] satisfies [Page, string][]) {
        await expect.poll(() => page.evaluate(incomingAudioLevel), { timeout: 10_000 }).toBeGreaterThan(0);
        const video = page
          .locator('[data-part="stage-tile"]')
          .filter({ has: tile(page, remote) })
          .locator("video");
        const frames = () => video.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
        await expect.poll(frames, { timeout: 10_000 }).toBeGreaterThan(5);
        const before = await frames();
        await expect.poll(frames, { timeout: 5000 }).toBeGreaterThan(before + 5);
      }
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
        const start = Date.now();
        await pages[0].getByRole("button", { name: "Share screen", exact: true }).click();
        for (const page of pages.slice(1)) {
          const video = page.locator('[data-stage-item^="screen"] video');
          await video.waitFor({ timeout: 10_000 });
          const frames = () => video.evaluate((element: HTMLVideoElement) => element.getVideoPlaybackQuality().totalVideoFrames);
          await expect.poll(frames, { timeout: 10_000 }).toBeGreaterThan(5);
          const before = await frames();
          await expect.poll(frames, { timeout: 5000 }).toBeGreaterThan(before + 5);
        }
        expect(Date.now() - start).toBeLessThan(10_000);
        await shot(pages, `C6-share-${attempt}`);
        await pages[0].getByRole("button", { name: "Stop sharing", exact: true }).click();
        for (const page of pages.slice(1)) await page.locator('[data-stage-item^="screen"]').waitFor({ state: "detached" });
      }
      await roster(pages);
    });
  });
});

test("C5 slow: visible student offline 140 seconds, one Rejoin without reload", async () => {
  await checkCase("C5", () =>
    classroom(async (pages, contexts) => {
      await drop(pages[1], contexts[1], 140_000, pages);
      await chat(pages[1], pages, "C5 chat after 140 seconds offline");
      await roster(pages);
      await shot(pages, "C5");
    }),
  );
});
