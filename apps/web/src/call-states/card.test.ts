import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startCallHarness } from "./browser-harness";

let origin: string;
let stop: (() => Promise<void>) | undefined;
let browser: Browser;

beforeAll(async () => {
  ({ origin, stop } = await startCallHarness());
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await stop?.();
  }
});

async function journey(run: (page: Page) => Promise<void>, phone = false) {
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone });
  const artifacts = process.env.CARD_ARTIFACTS;
  const trace = phone && artifacts ? `${artifacts}/phone-focus.zip` : undefined;
  if (trace && artifacts) {
    await mkdir(artifacts, { recursive: true });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }
  try {
    await run(await context.newPage());
  } finally {
    try {
      if (trace) await context.tracing.stop({ path: trace });
    } finally {
      await context.close();
    }
  }
}

async function capture(page: Page, name: string) {
  if (!process.env.CARD_ARTIFACTS) return;
  await mkdir(process.env.CARD_ARTIFACTS, { recursive: true });
  await page.screenshot({ path: `${process.env.CARD_ARTIFACTS}/${name}.png` });
}

it("downloads a cross-origin inline photo with its filename, without a new tab, and retries failures", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6cAAAAASUVORK5CYII=", "base64");
  let failDownload = false;
  const images = createServer((_request, response) => {
    response.writeHead(failDownload ? 503 : 200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": origin, "Cache-Control": "no-store" });
    response.end(failDownload ? "unavailable" : bytes);
  });
  images.listen(0, "127.0.0.1");
  await once(images, "listening");
  try {
    const address = images.address();
    if (!address || typeof address === "string") throw new Error("Image server has no port");
    const photoUrl = `http://127.0.0.1:${address.port}/photo.png`;
    await journey(async (page) => {
      await page.goto(`${origin}/call-states.html?state=card-photo-cross-origin&photoUrl=${encodeURIComponent(photoUrl)}`);
      await page.getByRole("button", { name: /^People,/ }).click();
      await page.getByRole("tab", { name: "Chat", exact: true }).click();
      await page.getByRole("button", { name: "View q9labs-logo-lockup-white-on-black.jpg", exact: true }).click();
      const viewer = page.getByRole("dialog", { name: "Photo viewer" });
      const image = viewer.getByRole("img", { name: "q9labs-logo-lockup-white-on-black.jpg", exact: true });
      await image.waitFor();
      await image.evaluate((element) => {
        if (!(element instanceof HTMLImageElement)) throw new Error("Photo viewer image is missing");
        return element.decode();
      });
      expect(await image.getAttribute("src")).toBe(photoUrl);
      const pages = page.context().pages().length;
      let downloads = 0;
      page.on("download", () => downloads++);
      const downloadButton = viewer.getByRole("button", { name: "Download q9labs-logo-lockup-white-on-black.jpg", exact: true });
      failDownload = true;
      await downloadButton.click();
      await viewer.getByRole("alert").waitFor();
      expect(await downloadButton.isEnabled()).toBe(true);
      expect(downloads).toBe(0);
      failDownload = false;
      const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
      expect(download.suggestedFilename()).toBe("q9labs-logo-lockup-white-on-black.jpg");
      expect(await download.failure()).toBeNull();
      const saved = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of saved) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect(downloads).toBe(1);
      expect(page.context().pages()).toHaveLength(pages);
      expect(await image.getAttribute("src")).toBe(photoUrl);
      expect(await viewer.isVisible()).toBe(true);
      expect((await fetch(photoUrl)).headers.get("Content-Disposition")).toBeNull();
    });
  } finally {
    await new Promise<void>((resolve, reject) => images.close((error) => (error ? reject(error) : resolve())));
  }
}, 30_000);

async function openPeople(page: Page, state = "card-people") {
  await page.goto(`${origin}/call-states.html?state=${state}`);
  if (state !== "card-knocks") {
    if (await page.getByRole("button", { name: "More options", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "More options", exact: true }).click();
      await page.getByRole("dialog", { name: "More options", exact: true }).getByRole("button", { name: "People", exact: true }).click();
    } else await page.getByRole("button", { name: /^People, \d+$/ }).click();
  }
  await page.getByRole("tab", { name: /^People/ }).waitFor();
}

it(
  "opens People and Chat by keyboard, then Escape returns to the People control",
  async () =>
    journey(async (page) => {
      await page.goto(`${origin}/call-states.html?state=card-guest`);
      const opener = page.getByRole("button", { name: /^People, \d+$/ });
      await opener.focus();
      await page.keyboard.press("Enter");
      const people = page.getByRole("tab", { name: /^People/ });
      await people.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.querySelector('[data-card-tab="chat"]')?.getAttribute("aria-selected") === "true");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("People, "));
      expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);
      await people.waitFor({ state: "hidden" });
    }),
  30_000,
);

it(
  "previews an image, sends it, and opens a dark photo viewer in Light",
  async () =>
    journey(async (page) => {
      await page.goto(`${origin}/call-states.html?state=card-chat-light`);
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6cAAAAASUVORK5CYII=", "base64");
      await page.getByLabel("Choose attachments").setInputFiles(["sample.png", "second.png"].map((name) => ({ name, mimeType: "image/png", buffer })));
      await page.getByRole("img", { name: "Preview of sample.png" }).waitFor();
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Here is the image");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const image = page.getByRole("button", { name: "View sample.png", exact: true });
      await image.waitFor();
      await capture(page, "laptop-chat-image-light");
      await image.click();
      const viewer = page.getByRole("dialog", { name: "Photo viewer" });
      expect(await viewer.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(8, 8, 10, 0.94)");
      await page.getByRole("button", { name: "Next image", exact: true }).click();
      await viewer.getByRole("img", { name: "second.png", exact: true }).waitFor();
      await page.keyboard.press("ArrowLeft");
      await viewer.getByRole("img", { name: "sample.png", exact: true }).waitFor();
      await capture(page, "laptop-photo-viewer-light");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "View sample.png");
    }),
  30_000,
);

it(
  "adds and removes a message reaction with its count",
  async () =>
    journey(async (page) => {
      await page.goto(`${origin}/call-states.html?state=card-chat`);
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      const message = page.locator(".call-message").first();
      await message.focus();
      const reaction = message.getByRole("button", { name: /^React with / }).first();
      const emoji = (await reaction.getAttribute("aria-label"))!.replace("React with ", "");
      await reaction.click();
      const chip = message.getByRole("button", { name: `${emoji}, 1: You`, exact: true });
      await chip.waitFor();
      expect(await chip.getAttribute("aria-pressed")).toBe("true");
      await chip.click();
      await chip.waitFor({ state: "detached" });
    }),
  30_000,
);

it(
  "lets a host let a knock in and hides host controls from a guest",
  async () =>
    journey(async (page) => {
      await openPeople(page, "card-knocks");
      await capture(page, "laptop-knocks-dark");
      await page.getByRole("button", { name: "Let Rania Aziz in", exact: true }).click();
      await page.getByRole("button", { name: "Let Rania Aziz in", exact: true }).waitFor({ state: "detached" });
      await openPeople(page, "card-guest");
      expect(await page.getByRole("button", { name: "Mute everyone", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Who can join", exact: true }).count()).toBe(0);
    }),
  30_000,
);

it(
  "cancels bulk mute without changing microphones and confirms the supported action",
  async () =>
    journey(async (page) => {
      await openPeople(page);
      const people = page.getByRole("region", { name: "People", exact: true });
      const mute = people.getByRole("button", { name: "Mute everyone", exact: true });
      const muted = people.getByRole("img", { name: "Microphone off", exact: true });
      expect(await muted.count()).toBe(1);
      await mute.click();
      const confirmation = page.getByRole("dialog", { name: "Mute everyone", exact: true });
      await confirmation.waitFor();
      await capture(page, "laptop-mute-confirm-dark");
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirmation.waitFor({ state: "hidden" });
      expect(await muted.count()).toBe(1);
      await mute.click();
      await confirmation.getByRole("button", { name: "Mute everyone", exact: true }).click();
      await confirmation.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.querySelectorAll('.call-people [aria-label="Microphone off"]').length === 3);
      expect(await mute.isDisabled()).toBe(true);
    }),
  30_000,
);

it(
  "keeps phone focus inside its sheet and captures both themes",
  async () =>
    journey(async (page) => {
      for (const scheme of ["dark", "light"] as const) {
        await openPeople(page, scheme === "dark" ? "card-people" : "card-people-light");
        const sheet = page.getByRole("dialog", { name: "People and Chat" });
        await sheet.waitFor();
        for (let index = 0; index < 16; index++) {
          await page.keyboard.press("Tab");
          const immediate = await sheet.evaluate((element) => ({ inside: element.contains(document.activeElement), active: document.activeElement?.outerHTML.slice(0, 300) }));
          const began = Date.now();
          try {
            await page.waitForFunction(() => document.querySelector('[role="dialog"][data-variant="panel"]')?.contains(document.activeElement), undefined, { timeout: 1500 });
          } finally {
            const settled = await sheet.evaluate((element) => ({ inside: element.contains(document.activeElement), active: document.activeElement?.outerHTML.slice(0, 300) }));
            if (process.env.CARD_ARTIFACTS) await writeFile(`${process.env.CARD_ARTIFACTS}/focus-${scheme}-${index}.json`, JSON.stringify({ scheme, index, immediate, settled, waitMs: Date.now() - began }, null, 2));
          }
        }
        await capture(page, `phone-people-${scheme}`);
        await page.getByRole("tab", { name: "Chat", exact: true }).click();
        await capture(page, `phone-chat-${scheme}`);
        await page.getByRole("button", { name: "View q9labs-logo-lockup-white-on-black.jpg", exact: true }).click();
        const photo = page.getByRole("dialog", { name: "Photo viewer" });
        await photo.waitFor();
        await page.keyboard.press("Escape");
        await photo.waitFor({ state: "hidden" });
        expect(await sheet.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await sheet.waitFor({ state: "hidden" });
      }
    }, true),
  30_000,
);

it(
  "does not offer People when the participants feature is disabled",
  async () =>
    journey(async (page) => {
      await page.goto(`${origin}/call-states.html?state=card-chat-only`);
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      const chat = page.getByRole("tab", { name: "Chat", exact: true });
      await chat.waitFor();
      expect(await page.getByRole("tab", { name: /^People/ }).count()).toBe(0);
      await chat.focus();
      await page.keyboard.press("ArrowLeft");
      expect(await chat.getAttribute("aria-selected")).toBe("true");
    }),
  30_000,
);
