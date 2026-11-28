// Renders every Helper window state in Chromium with a mocked Tauri bridge.
// Usage: node probe/ui-shots.mjs <output-dir>   (needs Playwright, e.g. from apps/web)
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { OVERLAY_STATES, SETTINGS_STATES } from "./ui-fixtures.mjs";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const { chromium } = require("playwright");
const root = fileURLToPath(new URL("../ui/", import.meta.url));
const out = process.argv[2];
if (!out) throw new Error("Pass an output directory.");
await mkdir(out, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((request, response) => {
  const path = normalize(join(root, request.url === "/" ? "index.html" : request.url.split("?")[0]));
  if (!path.startsWith(root)) return response.writeHead(403).end();
  const stream = createReadStream(path);
  stream.on("error", () => response.writeHead(404).end());
  stream.on("open", () => response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }));
  stream.pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;

// Real window sizes from src-tauri/src/desktop.rs: Settings 460x640, island 246x42, pill 160x42, draw bar 258x44.
const jobs = [
  ...Object.entries(SETTINGS_STATES).map(([name, view]) => ({ name: `settings-${name}`, label: "settings", view, size: { width: 460, height: 640 } })),
  { name: "hud-island", label: "hud", view: OVERLAY_STATES.hud, size: { width: 246, height: 42 } },
  { name: "hud-pill", label: "hud", view: { ...OVERLAY_STATES.hud, preferences: { style: "pill", dock: { edge: "top", offset: 0.5 } } }, size: { width: 160, height: 42 } },
  { name: "draw-bar", label: "draw-bar", view: OVERLAY_STATES["draw-bar"], size: { width: 258, height: 44 } },
];

const mocked = ({ label, view }) => {
  window.__ACTS__ = [];
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
  window.__TAURI__ = { core: { invoke: async (command, args) => (command === "view" ? window.__VIEW__ : void window.__ACTS__.push(args.action)) }, event: { listen: async () => () => {} } };
  window.__VIEW__ = view;
};

const browser = await chromium.launch();
const failures = [];
for (const job of jobs) {
  const page = await browser.newPage({ viewport: job.size, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => failures.push(`${job.name}: ${error}`));
  await page.addInitScript(mocked, { label: job.label, view: job.view });
  await page.goto(origin);
  await page.waitForTimeout(500);
  if (job.name === "settings-device") await page.evaluate(() => document.querySelector("#use-code")?.click());
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${job.name}.png`) });
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1);
  if (overflow) failures.push(`${job.name}: content taller than the window`);
  await page.close();
}

async function open(view) {
  const context = await browser.newContext({ viewport: { width: 460, height: 640 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.addInitScript(mocked, { label: "settings", view });
  await page.goto(origin);
  await page.waitForTimeout(400);
  return page;
}
const check = (name, ok) => ok || failures.push(`behaviour: ${name}`);

let page = await open(SETTINGS_STATES.pair);
check("focus lands on the pairing card", (await page.evaluate(() => document.activeElement?.id)) === "card-pair");
check("fingerprint is read one character at a time", (await page.getAttribute("#pair-code", "aria-label")) === "Fingerprint 4 F 2 A 9 1 C 0");
check("state change is announced with the fingerprint", /Does your call show this\? Fingerprint 4 F 2 A 9 1 C 0/.test(await page.textContent("#announce")));
await page.keyboard.press("Tab");
check("tab goes to the primary action first", (await page.evaluate(() => document.activeElement?.id)) === "allow");
await page.keyboard.press("Tab");
check("then No", (await page.evaluate(() => document.activeElement?.id)) === "deny");
await page.focus("#allow");
await page.keyboard.press("Enter");
check("Enter on Allow allows with the fingerprint", JSON.stringify(await page.evaluate(() => window.__ACTS__.at(-1))) === '{"kind":"decide_pairing","fingerprint":"4F2A-91C0","allowed":true}');
await page.focus("#card-pair");
await page.keyboard.press("Escape");
check("Escape denies", JSON.stringify(await page.evaluate(() => window.__ACTS__.at(-1))) === '{"kind":"decide_pairing","fingerprint":"4F2A-91C0","allowed":false}');
await page.context().close();

page = await open(SETTINGS_STATES.confirm);
check("focus lands on the code card", (await page.evaluate(() => document.activeElement?.id)) === "card-confirm");
check("code is grouped in fours", (await page.textContent("#confirm-code")) === "K7QM-2X9F-HT4C-WP6N");
check("code is read one character at a time", (await page.getAttribute("#confirm-code", "aria-label")) === "Code K 7 Q M 2 X 9 F H T 4 C W P 6 N");
await page.click("#copy-confirm");
await page.waitForFunction(() => document.querySelector("#copy-confirm").textContent === "Copied");
check("copy shows Copied", (await page.textContent("#copy-confirm")) === "Copied");
check("clipboard holds the code", (await page.evaluate(() => navigator.clipboard.readText())) === "K7QM-2X9F-HT4C-WP6N");
await page.context().close();

page = await open(SETTINGS_STATES.waiting);
check(
  "login switch has a name and state",
  (await page.evaluate(() => {
    const b = document.querySelector("#launch-at-login");
    return b.getAttribute("role") + b.getAttribute("aria-checked") + b.getAttribute("aria-labelledby");
  })) === "switchtruelogin-label",
);
await page.context().close();

page = await open(SETTINGS_STATES.permission);
check("focus lands on the permission action", (await page.evaluate(() => document.activeElement?.id)) === "permission-primary");
await page.keyboard.press("Escape");
check("Escape means Not now", (await page.evaluate(() => window.__ACTS__.at(-1)?.kind)) === "later_screen_recording");
await page.context().close();

page = await open(SETTINGS_STATES.display);
check("focus lands on the first display", (await page.evaluate(() => document.activeElement?.textContent)) === "Built-in display");
await page.keyboard.press("Enter");
check("Enter picks it", JSON.stringify(await page.evaluate(() => window.__ACTS__.at(-1))) === '{"kind":"select_monitor","index":0}');
await page.context().close();

page = await open({ ...SETTINGS_STATES.display, monitors: [SETTINGS_STATES.display.monitors[0]] });
check("a single display is chosen without asking", JSON.stringify(await page.evaluate(() => window.__ACTS__)) === '[{"kind":"select_monitor","index":0}]');
await page.context().close();

page = await open(SETTINGS_STATES.waiting);
const hidden = await page.evaluate(() => document.body.innerText.match(/fingerprint|Account ID|Remove local|Island|Pill|unverified/i)?.[0] ?? null);
check("no developer copy in the default view", hidden === null);
await page.context().close();

await browser.close();
server.close();
console.log(failures.length ? failures.join("\n") : "all states rendered, no overflow, no page errors");
process.exitCode = failures.length ? 1 : 0;
