/** The journeys a leak run repeats. One cycle takes the fixture call through a user action and back, so retained resources show as growth. */

export const LEAK_JOURNEYS = ["idle", "leave", "panels", "people", "share", "board", "reconnect", "layout", "reactions"];

const fixture = (page, name) => page.locator(`[data-perf-${name}]`).dispatchEvent("click");
const click = (page, name) => page.getByRole("button", { name, exact: true }).click();
const leaveButton = (page) => page.getByRole("button", { name: "Leave call", exact: true });

/** Self-test injections: a listener nobody removes, or detached nodes nobody lets go. */
function injectLeak(page, kind) {
  return page.evaluate((injection) => {
    if (injection === "listener") document.addEventListener("chalk-leak-probe", () => Math.random());
    else {
      window.__detachedLeak ??= [];
      for (let i = 0; i < 30; i++) {
        const node = document.createElement("section");
        document.body.append(node);
        node.remove();
        window.__detachedLeak.push(node);
      }
    }
  }, kind);
}

async function idle(page) {
  await page.evaluate(() => undefined);
  await page.evaluate(() => undefined);
}

async function leave(page) {
  if ((await leaveButton(page).count()) === 0) {
    await fixture(page, "join");
    await leaveButton(page).waitFor();
    await page.waitForTimeout(100);
  }
  await click(page, "Leave call");
  await leaveButton(page).waitFor({ state: "hidden" });
}

async function panels(page, injection) {
  for (const [open, close] of [
    ["Chat", "Close panel"],
    [/^People, \d+$/, "Close panel"],
  ]) {
    await click(page, open);
    await page.getByRole("button", { name: close, exact: true }).waitFor();
    if (injection) await injectLeak(page, injection);
    await click(page, close);
    await page.getByRole("button", { name: close, exact: true }).waitFor({ state: "hidden" });
  }
}

async function layout(page) {
  await click(page, "Switch to grid");
  await click(page, "Switch to spotlight");
}

async function reactions(page) {
  await fixture(page, "reactions");
  await page.waitForFunction(() => document.body.textContent.includes("🎉"));
  await page.waitForTimeout(4300);
}

/** A journey that flips one fixture control on and then off. */
function toggle(on, off, { board = false } = {}) {
  return async (page) => {
    await fixture(page, on);
    if (board) await page.locator(".excalidraw canvas").first().waitFor({ state: "visible", timeout: 30000 });
    await page.waitForTimeout(400);
    await fixture(page, off);
    if (board) await page.locator(".excalidraw canvas").first().waitFor({ state: "hidden" });
  };
}

const CYCLES = {
  idle,
  leave,
  panels,
  layout,
  reactions,
  people: toggle("people-in", "people-out"),
  share: toggle("share-on", "share-off"),
  board: toggle("board-on", "board-off", { board: true }),
  reconnect: toggle("reconnect", "recover"),
};

/** The function that runs one cycle of `journey` on `page`. */
export function journeyCycle(page, journey, injection) {
  return () => CYCLES[journey](page, injection);
}

/** The first mount is joined. The leave journey starts from the left state so warm-up exercises the same rejoin path (including Playwright's dispatch helper) as every measured cycle. */
export async function startJourney(page, journey) {
  if (journey !== "leave") return;
  await click(page, "Leave call");
  await leaveButton(page).waitFor({ state: "hidden" });
}
