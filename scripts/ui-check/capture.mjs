// Walks the journeys against one running call-state harness and records, for every frame, the layout findings,
// console errors and a screenshot. Run once on the branch and once on master; compare.mjs diffs the two.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { JOURNEYS, SCHEMES, SIZES } from "./journeys.mjs";
import { MIN_TARGET, pageChecks } from "./page-checks.mjs";

const FIXED_TIME = new Date("2026-01-15T10:00:00Z");
const STILL = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";
const PER_CHECK = 25;

async function pool(items, size, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

/** A state whose id ends in -light or -dark paints its own scheme, so only that scheme is walked. */
const schemesFor = (state) => (state.endsWith("-light") ? ["light"] : state.endsWith("-dark") ? ["dark"] : SCHEMES);

export function planRuns(only) {
  const runs = [];
  for (const journey of JOURNEYS) {
    if (only && !only.some((prefix) => journey.id.startsWith(prefix))) continue;
    for (const size of SIZES) for (const scheme of schemesFor(journey.state)) runs.push({ journey, size, scheme });
  }
  return runs;
}

async function settledScreenshot(page, path) {
  // Two shots a moment apart must match, so a late paint cannot make the same screen differ between runs.
  let previous = await page.screenshot({ animations: "disabled" });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(150);
    const next = await page.screenshot({ animations: "disabled" });
    if (next.equals(previous)) break;
    previous = next;
  }
  await writeFile(path, previous);
}

async function runOne({ browser, origin, out, run, errorsByRun }) {
  const { journey, size, scheme } = run;
  const name = `${journey.id}@${size.id}-${scheme}`;
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    colorScheme: scheme,
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    isMobile: size.mobile,
    hasTouch: size.mobile,
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message.split("\n")[0]));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().split("\n")[0]);
  });
  const frames = [];
  try {
    await context.clock.setFixedTime(FIXED_TIME);
    await page.goto(`${origin}/${journey.page ?? "call-states.html"}?state=${journey.state}`, { waitUntil: "load" });
    await page.addStyleTag({ content: STILL });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    const frame = async (step, label, extra = []) => {
      const findings = [...(await page.evaluate(pageChecks, { minTarget: MIN_TARGET, perCheck: PER_CHECK })), ...extra];
      const shot = `${name}.${step}.png`;
      await settledScreenshot(page, join(out, shot));
      frames.push({ frame: `${name}.${step}`, journey: journey.id, size: size.id, scheme, step, label, shot, findings });
    };
    await frame(0, "opened");
    for (const [index, step] of journey.steps.entries()) {
      const before = await page.evaluate(() => document.body.innerHTML);
      const extra = [];
      if ("click" in step) {
        const target = page
          .getByRole("button", { name: step.click, exact: true })
          .or(page.getByRole("menuitem", { name: step.click, exact: true }))
          .first();
        try {
          await target.click({ timeout: 4000 });
        } catch (error) {
          extra.push({ check: "control-unreachable", key: step.click, detail: `"${step.click}" could not be clicked: ${error.message.split("\n")[0]}` });
        }
        await page.waitForTimeout(500);
        if (extra.length === 0 && (await page.evaluate(() => document.body.innerHTML)) === before) extra.push({ check: "dead-control", key: step.click, detail: `clicking "${step.click}" changed nothing on the page` });
        await frame(index + 1, `after clicking ${step.click}`, extra);
      } else {
        await page.keyboard.press(step.key);
        await page.waitForTimeout(500);
        await frame(index + 1, `after pressing ${step.key}`);
      }
    }
  } catch (error) {
    frames.push({ frame: `${name}.error`, journey: journey.id, size: size.id, scheme, step: -1, label: "failed to run", shot: null, findings: [{ check: "journey-failed", key: name, detail: error.message.split("\n")[0] }] });
  } finally {
    errorsByRun.set(name, consoleErrors);
    await context.close();
  }
  return frames;
}

/** @returns {Promise<{ frames: object[], consoleErrors: Record<string, string[]> }>} */
export async function capture({ origin, out, only, concurrency = 3 }) {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch();
  const errorsByRun = new Map();
  const frames = [];
  try {
    await pool(planRuns(only), concurrency, async (run) => {
      frames.push(...(await runOne({ browser, origin, out, run, errorsByRun })));
    });
  } finally {
    await browser.close();
  }
  for (const frame of frames) {
    const runName = frame.frame.replace(/\.(\d+|error)$/u, "");
    if (frame.step === 0) for (const message of errorsByRun.get(runName) ?? []) frame.findings.push({ check: "console-error", key: message.replace(/\d+/gu, "N").slice(0, 120), detail: message.slice(0, 200) });
  }
  frames.sort((a, b) => a.frame.localeCompare(b.frame));
  await writeFile(join(out, "frames.json"), JSON.stringify(frames, null, 1));
  return { frames };
}
