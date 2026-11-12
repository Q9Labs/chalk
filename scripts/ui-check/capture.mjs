// Walks the journeys against one running call-state harness and records, for every frame, the layout findings,
// console errors and a screenshot. Run once on the branch and once on master; compare.mjs diffs the two.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { JOURNEYS, SCHEMES, SIZES } from "./journeys.mjs";
import { MIN_TARGET, pageChecks } from "./page-checks.mjs";

const FIXED_TIME = new Date("2026-01-15T10:00:00Z");
const STILL = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}.chalk-board-cursors{visibility:hidden!important}";
const PER_CHECK = 25;
/** Parts of a screen that move on their own (the live input meter) or hold this server's address (the invite QR code) are painted over in every screenshot. Remote board cursors roam by the clock, so STILL hides their layer. */
const LIVE = '[role="meter"], .chalk-invite-qr';

/**
 * Runs in every page before its own scripts. A screen that changes by itself after a few seconds (the call's header and dock
 * hide when idle, a notice leaves, a reconnect banner appears) would show whatever the load of this machine allowed, so a timer
 * of 2.5 seconds or more never fires: the screen stays as it was when it settled. The clock is fixed here too, because Playwright's
 * own fixed clock would replace this setTimeout.
 */
const FROZEN = `(() => {
  const set = window.setTimeout.bind(window);
  window.__realSetTimeout = set;
  window.setTimeout = (handler, delay, ...rest) => set(handler, Number(delay) >= 2500 ? 2147483647 : delay, ...rest);
  const Real = Date;
  const now = ${FIXED_TIME.getTime()};
  window.Date = class extends Real {
    constructor(...args) {
      if (args.length) super(...args);
      else super(now);
    }
    static now() {
      return now;
    }
  };
})();`;

/** Resolves when nothing in the page has changed for `quiet` ms (at most `cap` ms), fonts are loaded and every image is decoded. Live parts do not count. */
const settle = (page) =>
  page.evaluate(
    async ({ live, quiet, cap }) => {
      await document.fonts.ready;
      await new Promise((resolve) => {
        // The page's own setTimeout never fires for 2.5 s or more (FROZEN), so the cap needs the real one.
        const wait = window.__realSetTimeout;
        let timer = 0;
        const finish = () => {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(limit);
          resolve(undefined);
        };
        const observer = new MutationObserver((records) => {
          const real = records.some((record) => !(record.target instanceof Element ? record.target : record.target.parentElement)?.closest(live));
          if (!real) return;
          clearTimeout(timer);
          timer = wait(finish, quiet);
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        timer = wait(finish, quiet);
        const limit = wait(finish, cap);
      });
      await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
    },
    { live: LIVE, quiet: 300, cap: 3000 },
  );

async function pool(items, size, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async (_, worker) => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item, worker);
    }),
  );
}

/** A state whose id ends in -light or -dark paints its own scheme, so only that scheme is walked. */
const schemesFor = (state) => {
  const id = state.split("&")[0];
  return id.endsWith("-light") ? ["light"] : id.endsWith("-dark") ? ["dark"] : SCHEMES;
};

export function planRuns(only) {
  const runs = [];
  for (const journey of JOURNEYS) {
    if (only && !only.some((prefix) => journey.id.startsWith(prefix))) continue;
    for (const size of SIZES) {
      if (journey.sizes && !journey.sizes.includes(size.id)) continue;
      // The tablet is walked in one theme: it shares its layout rules with the phone and the desktop, which run in both.
      const schemes = schemesFor(journey.state).filter((scheme) => size.id !== "tablet" || scheme === "dark" || schemesFor(journey.state).length === 1);
      for (const scheme of schemes) runs.push({ journey, size, scheme });
    }
  }
  return runs;
}

/** The first visible button or menu item named like one of `names`; opens the `via` control first when none shows. */
async function findControl(page, names, via) {
  const visible = async () => {
    for (const exact of [true, false]) {
      for (const name of names) {
        const match = page.getByRole("button", { name, exact }).or(page.getByRole("menuitem", { name, exact })).or(page.getByRole("menuitemradio", { name, exact }));
        for (const candidate of await match.all()) if (await candidate.isVisible()) return candidate;
      }
    }
    return null;
  };
  const direct = await visible();
  if (direct || !via) return direct;
  const gate = page.getByRole("button", { name: via, exact: true }).first();
  if (!(await gate.isVisible())) return null;
  await gate.click({ timeout: 4000 });
  await page.waitForTimeout(400);
  return visible();
}

async function settledScreenshot(page, path) {
  // Two shots a moment apart must match, so a late paint cannot make the same screen differ between runs.
  const options = { animations: "disabled", mask: [page.locator(LIVE)] };
  let previous = await page.screenshot(options);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(120);
    const next = await page.screenshot(options);
    if (next.equals(previous)) break;
    previous = next;
  }
  await writeFile(path, previous);
}

/** Layout findings that show in two measurements a moment apart; a screen still loading cannot flicker one in. */
async function stableFindings(page) {
  const first = await page.evaluate(pageChecks, { minTarget: MIN_TARGET, perCheck: PER_CHECK });
  await page.waitForTimeout(250);
  const second = await page.evaluate(pageChecks, { minTarget: MIN_TARGET, perCheck: PER_CHECK });
  const again = new Set(second.map((finding) => `${finding.check}|${finding.key}`));
  return first.filter((finding) => again.has(`${finding.check}|${finding.key}`));
}

function contextFor(browser, contexts, size, scheme) {
  const key = `${size.id}-${scheme}`;
  if (!contexts.has(key)) {
    contexts.set(
      key,
      browser
        .newContext({
          viewport: { width: size.width, height: size.height },
          colorScheme: scheme,
          reducedMotion: "reduce",
          deviceScaleFactor: 1,
          isMobile: size.mobile,
          hasTouch: size.mobile,
          locale: "en-US",
          timezoneId: "UTC",
        })
        .then(async (context) => {
          await context.addInitScript(FROZEN);
          return context;
        }),
    );
  }
  return contexts.get(key);
}

async function runOne({ context, origin, out, run }) {
  const { journey, size, scheme } = run;
  const name = `${journey.id}@${size.id}-${scheme}`;
  const runStart = Date.now();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message.split("\n")[0]));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().split("\n")[0]);
  });
  const frames = [];
  try {
    await page.goto(`${origin}/${journey.page ?? "call-states.html"}?state=${journey.state}`, { waitUntil: "load" });
    await page.addStyleTag({ content: STILL });
    await page.evaluate(() => document.fonts.ready);
    // A call page is ready once its dock shows; heavy layouts such as 30 tiles can take seconds to get there under load.
    await page
      .locator(journey.ready ?? (journey.page ? "button" : 'button[aria-label="Leave call"]'))
      .first()
      .waitFor({ timeout: 25_000 });
    await settle(page);
    const frame = async (step, label, extra = []) => {
      // A sheet that animates with script (not CSS) is still sliding in when measured unless every animation is finished.
      await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
      await settle(page);
      const findings = [...(await stableFindings(page)), ...extra];
      const shot = `${name}.${step}.png`;
      await settledScreenshot(page, join(out, shot));
      frames.push({ frame: `${name}.${step}`, journey: journey.id, size: size.id, scheme, step, label, shot, findings });
    };
    await frame(0, "opened");
    for (const [index, step] of journey.steps.entries()) {
      const extra = [];
      if ("click" in step) {
        const names = [step.click].flat();
        const target = await findControl(page, names, step.via);
        // Measured after any sheet that holds the control is open, so only the control's own effect counts.
        const before = await page.evaluate(() => document.body.innerHTML);
        if (!target) extra.push({ check: "control-unreachable", key: names[0], detail: `no visible control named "${names.join('" or "')}"${step.via ? ` (also looked behind "${step.via}")` : ""}` });
        else {
          try {
            await target.click({ timeout: 4000 });
          } catch (error) {
            extra.push({ check: "control-unreachable", key: names[0], detail: `"${names[0]}" could not be clicked: ${error.message.split("\n")[0]}` });
          }
        }
        if (step.ready && extra.length === 0)
          await page
            .locator(step.ready)
            .first()
            .waitFor({ timeout: 30_000 })
            .catch(() => extra.push({ check: "never-ready", key: step.ready, detail: `${step.ready} did not appear after clicking "${names[0]}"` }));
        await page.waitForTimeout(250);
        if (extra.length === 0 && (await page.evaluate(() => document.body.innerHTML)) === before) extra.push({ check: "dead-control", key: names[0], detail: `clicking "${names[0]}" changed nothing on the page` });
        await frame(index + 1, `after clicking ${names[0]}`, extra);
      } else {
        await page.keyboard.press(step.key);
        await page.waitForTimeout(250);
        await frame(index + 1, `after pressing ${step.key}`);
      }
    }
  } catch (error) {
    frames.push({ frame: `${name}.error`, journey: journey.id, size: size.id, scheme, step: -1, label: "failed to run", shot: null, findings: [{ check: "journey-failed", key: name, detail: error.message.split("\n")[0] }] });
  } finally {
    await page.close().catch(() => undefined);
  }
  const first = frames.find((frame) => frame.step === 0);
  if (first) for (const message of consoleErrors) first.findings.push({ check: "console-error", key: message.replace(/\d+/gu, "N").slice(0, 120), detail: message.slice(0, 200) });
  if (process.env.UI_CHECK_TIMING) console.error(`timing ${name} total ${Date.now() - runStart}ms`);
  return frames;
}

/** @returns {Promise<{ frames: object[] }>} */
export async function capture({ origin, out, only, concurrency }) {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch();
  // One browser context per size and theme is shared by every journey.
  const contexts = new Map();
  const frames = [];
  try {
    await pool(planRuns(only), concurrency, async (run) => {
      const context = await contextFor(browser, contexts, run.size, run.scheme);
      frames.push(...(await runOne({ context, origin, out, run })));
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
  frames.sort((a, b) => a.frame.localeCompare(b.frame));
  await writeFile(join(out, "frames.json"), JSON.stringify(frames, null, 1));
  return { frames };
}
