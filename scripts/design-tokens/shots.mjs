#!/usr/bin/env node
// Screenshots for design-token PRs: shoot every screen before and after, then count changed pixels.
//
//   node scripts/design-tokens/shots.mjs shoot --out DIR --states URL [--web URL] [--only REGEX]
//   node scripts/design-tokens/shots.mjs compare BEFORE_DIR AFTER_DIR --out DIR
//
// --states is the call-state harness (cd apps/web && CHALK_CALL_STATES_PORT=3171 pnpm exec vite --config vite.call-states.config.ts).
// --web is the web app dev server (cd apps/web && pnpm exec vite dev --port 3172). Call states already come in dark and light
// variants; web pages are shot at desktop and phone width in both color schemes.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { DASHBOARD_PATHS, installDashboardStubs } from "./dashboard-stubs.mjs";

const [command, ...rest] = process.argv.slice(2);
const option = (name) => {
  const index = rest.indexOf(`--${name}`);
  return index === -1 ? undefined : rest[index + 1];
};
const positional = rest.filter((arg, i) => !arg.startsWith("--") && !rest[i - 1]?.startsWith("--"));

const STILL = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
const WEB_PAGES = ["/", "/docs", "/privacy", "/terms", "/dashboard/sign-in"];
const slug = (text) =>
  text
    .replace(/^\//u, "")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-|-$/gu, "") || "home";

async function pool(items, size, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

async function shoot() {
  const out = option("out");
  const states = option("states");
  const web = option("web");
  const only = option("only") ? new RegExp(option("only"), "u") : undefined;
  if (!out || (!states && !web)) throw new Error("shoot needs --out and --states and/or --web");
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const jobs = [];

  if (states) {
    const probe = await browser.newPage();
    await probe.goto(`${states}/call-states.html`);
    await probe.waitForFunction(() => window.__CALL_STATES__);
    const ids = await probe.evaluate(() => window.__CALL_STATES__.map((state) => state.id));
    await probe.close();
    for (const id of ids) jobs.push({ id: `state-${id}`, url: `${states}/call-states.html?state=${id}`, viewport: { width: 1280, height: 800 }, fullPage: false, scheme: "dark" });
  }
  if (web) {
    const probe = await browser.newPage();
    await probe.goto(`${web}/docs`);
    const links = await probe.evaluate(() => [...document.querySelectorAll("a[href^='/docs/']")].map((a) => a.getAttribute("href")));
    await probe.close();
    for (const path of new Set([...WEB_PAGES, ...links])) {
      for (const [device, viewport] of [
        ["desktop", { width: 1440, height: 900 }],
        ["phone", { width: 390, height: 844 }],
      ]) {
        for (const scheme of ["light", "dark"]) jobs.push({ id: `web-${slug(path)}-${device}-${scheme}`, url: `${web}${path}`, viewport, fullPage: true, scheme });
      }
    }
    for (const path of DASHBOARD_PATHS) {
      for (const [device, viewport] of [
        ["desktop", { width: 1440, height: 900 }],
        ["phone", { width: 390, height: 844 }],
      ]) {
        for (const scheme of ["light", "dark"]) jobs.push({ id: `dash-${slug(path.replace(/[0-9a-f-]{36}/gu, "id"))}-${device}-${scheme}`, url: `${web}${path}`, viewport, fullPage: true, scheme, stub: true });
      }
    }
  }

  const selected = jobs.filter((job) => !only || only.test(job.id));
  let failures = 0;
  await pool(selected, 4, async (job) => {
    const context = await browser.newContext({ viewport: job.viewport, colorScheme: job.scheme, reducedMotion: "reduce", deviceScaleFactor: 1 });
    if (job.stub) await installDashboardStubs(context);
    const page = await context.newPage();
    try {
      await page.goto(job.url, { waitUntil: "load" });
      // Web pages fill in after their data requests answer; a blank shot would compare equal to itself.
      if (!job.id.startsWith("state-")) await page.waitForFunction(() => document.body.innerText.trim().length > 40);
      await page.addStyleTag({ content: STILL });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(out, `${job.id}.png`), fullPage: job.fullPage });
    } catch (error) {
      failures += 1;
      console.error(`FAILED ${job.id}: ${error.message.split("\n")[0]}`);
    } finally {
      await context.close();
    }
  });
  await browser.close();
  console.log(`shot ${selected.length - failures} of ${selected.length} into ${out}`);
}

/** Runs inside the page: counts pixels that differ, and returns a before | after | diff strip. */
async function compareInPage(pairs) {
  const load = (b64) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = `data:image/png;base64,${b64}`;
    });
  const results = [];
  for (const pair of pairs) {
    const before = await load(pair.before);
    const after = await load(pair.after);
    const width = Math.max(before.width, after.width);
    const height = Math.max(before.height, after.height);
    const read = (image) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.fillStyle = "#ff00ff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, width, height);
    };
    const a = read(before);
    const b = read(after);
    const diff = new ImageData(width, height);
    let changed = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const differs = a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2];
      if (differs) changed += 1;
      const grey = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3;
      diff.data.set(differs ? [255, 0, 60, 255] : [grey, grey, grey, 70], i);
      if (!differs) diff.data[i + 3] = 255;
    }
    let strip;
    if (changed > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = width * 3 + 20;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#888";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(before, 0, 0);
      context.drawImage(after, width + 10, 0);
      const layer = document.createElement("canvas");
      layer.width = width;
      layer.height = height;
      layer.getContext("2d").putImageData(diff, 0, 0);
      context.drawImage(layer, (width + 10) * 2, 0);
      strip = canvas.toDataURL("image/png").split(",")[1];
    }
    results.push({ id: pair.id, changed, total: width * height, sizeChanged: before.width !== after.width || before.height !== after.height, strip });
  }
  return results;
}

/** Runs inside the page: stacks strips into contact sheets, scaled to fit. */
async function sheetInPage([strips, perSheet]) {
  const load = (b64) =>
    new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.src = `data:image/png;base64,${b64}`;
    });
  const sheets = [];
  for (let start = 0; start < strips.length; start += perSheet) {
    const group = strips.slice(start, start + perSheet);
    const images = await Promise.all(group.map((item) => load(item.strip)));
    const width = 1800;
    const scaled = images.map((image) => ({ w: width, h: Math.min(Math.round((image.height * width) / image.width), 900) }));
    const height = scaled.reduce((sum, item) => sum + item.h + 28, 0);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#222";
    context.fillRect(0, 0, width, height);
    let y = 0;
    group.forEach((item, index) => {
      context.fillStyle = "#fff";
      context.font = "18px sans-serif";
      context.fillText(`${item.id}  (before | after | changed pixels in red): ${item.changed}`, 8, y + 20);
      const image = images[index];
      context.drawImage(image, 0, 0, image.width, Math.min(image.height, Math.round((scaled[index].h * image.width) / width)), 0, y + 28, width, scaled[index].h);
      y += scaled[index].h + 28;
    });
    sheets.push(canvas.toDataURL("image/png").split(",")[1]);
  }
  return sheets;
}

async function compare() {
  const [beforeDir, afterDir] = positional;
  const out = option("out");
  if (!beforeDir || !afterDir || !out) throw new Error("compare needs BEFORE_DIR AFTER_DIR --out DIR");
  mkdirSync(out, { recursive: true });
  const files = readdirSync(afterDir).filter((name) => name.endsWith(".png"));
  const beforeFiles = new Set(readdirSync(beforeDir));
  const pairs = files
    .filter((name) => beforeFiles.has(name))
    .map((name) => ({
      id: name.replace(/\.png$/u, ""),
      before: readFileSync(join(beforeDir, name)).toString("base64"),
      after: readFileSync(join(afterDir, name)).toString("base64"),
    }));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const results = [];
  for (let start = 0; start < pairs.length; start += 6) results.push(...(await page.evaluate(compareInPage, pairs.slice(start, start + 6))));
  const changed = results.filter((result) => result.changed > 0);
  const identical = results.length - changed.length;
  const summary = [
    `compared ${results.length} screens: ${identical} identical, ${changed.length} changed`,
    `only before: ${files.filter((name) => !beforeFiles.has(name)).length}, only after: ${[...beforeFiles].filter((name) => !files.includes(name)).length}`,
    ...results.map((result) => `${result.changed} ${result.id}${result.sizeChanged ? " (size changed)" : ""}`),
  ];
  writeFileSync(join(out, "diff.txt"), `${summary.join("\n")}\n`);
  const strips = changed.filter((result) => result.strip).map(({ id, changed: count, strip }) => ({ id, changed: count, strip }));
  // Full-page strips are large, so stack them into sheets in small batches rather than in one evaluate call.
  const sheets = [];
  for (let start = 0; start < strips.length; start += 15) sheets.push(...(await page.evaluate(sheetInPage, [strips.slice(start, start + 15), 3])));
  sheets.forEach((sheet, index) => writeFileSync(join(out, `sheet-${String(index + 1).padStart(2, "0")}.png`), Buffer.from(sheet, "base64")));
  await browser.close();
  console.log(summary[0]);
  console.log(`wrote diff.txt and ${sheets.length} contact sheets to ${out}`);
}

if (command === "shoot") await shoot();
else if (command === "compare") await compare();
else throw new Error("usage: shots.mjs shoot|compare ...");
