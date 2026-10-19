// Drives the dashboard build against the DTO fixture in headless Chromium and prints one line per check.
// Usage: node dashboard-checks.mjs <playwright index.mjs> <fixture origin>
const [playwrightPath, origin] = process.argv.slice(2);
const { chromium } = await import(playwrightPath);
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const CALL = `/dashboard/call/${uuid(0x100)}`;
const fixture = (query) => fetch(`${origin}/__fixture/${query}`).then((r) => r.json());
const browser = await chromium.launch({ ...(process.env.DASHBOARD_BROWSER_PATH ? { executablePath: process.env.DASHBOARD_BROWSER_PATH } : {}), headless: true });
const results = [];
const errors = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);

async function open(route, { account = "hasan", set = "", signedOut = false, theme = "dark", width = 1440 } = {}) {
  await fixture("reset");
  await fixture(`set?account=${account}${set ? `&${set}` : ""}`);
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const cookies = [{ name: "chalk_theme", value: theme, url: origin }];
  if (!signedOut) cookies.push({ name: "fx_session", value: account, url: origin });
  await context.addCookies(cookies);
  const tab = await context.newPage();
  tab.on("console", (message) => message.type() === "error" && errors.push(`${route}: ${message.text()}`));
  tab.on("pageerror", (error) => errors.push(`${route}: ${error.message}`));
  await tab.goto(`${origin}${route}`, { waitUntil: "networkidle" });
  await tab.waitForTimeout(500);
  return { tab, context };
}
const focused = (tab) => tab.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent?.trim() || document.activeElement?.tagName);
const inDialog = (tab) => tab.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog],[role=alertdialog]")));

/** Opens a dialog, tabs past its end and back, presses Esc, and checks focus went back to the opener. */
async function dialogCheck(tab, name, openDialog, opener) {
  await openDialog();
  await tab.waitForTimeout(300);
  const open = await tab.locator("[role=dialog],[role=alertdialog]").count();
  let trapped = true;
  for (let i = 0; i < 12; i++) {
    await tab.keyboard.press("Tab");
    trapped &&= await inDialog(tab);
  }
  for (let i = 0; i < 12; i++) {
    await tab.keyboard.press("Shift+Tab");
    trapped &&= await inDialog(tab);
  }
  await tab.keyboard.press("Escape");
  await tab.waitForTimeout(200);
  const closed = (await tab.locator("[role=dialog],[role=alertdialog]").count()) === 0;
  const back = opener ? (await focused(tab)) === opener : true;
  check(`dialog ${name}: opens, traps focus, Esc closes, focus returns`, open === 1 && trapped && closed && back, `open=${open} trapped=${trapped} closed=${closed} focus=${await focused(tab)}`);
}

try {
  for (const value of ["0", "1000", "-1", "1.5", "NaN", "Infinity", "", "1001", "2000000000"]) {
    const response = await fetch(`${origin}/__fixture/set?delay=${encodeURIComponent(value)}`);
    await response.arrayBuffer();
    const valid = value === "0" || value === "1000";
    check(`fixture delay ${JSON.stringify(value)}`, response.status === (valid ? 200 : 400), `status=${response.status}`);
  }
  await fixture("reset");
  const body = { action: "set-allowed-websites", origins: [], padding: "" };
  const overhead = Buffer.byteLength(JSON.stringify(body));
  for (const bytes of [1024 * 1024, 1024 * 1024 + 1]) {
    const response = await fetch(`${origin}/dashboard-api/developer`, {
      method: "POST",
      headers: { Origin: origin, Cookie: "fx_session=new", "X-CSRF-Token": "fixture-csrf-new", "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, padding: "x".repeat(bytes - overhead) }),
    });
    await response.arrayBuffer();
    check(`fixture body limit at ${bytes} bytes`, response.status === (bytes === 1024 * 1024 ? 200 : 413), `status=${response.status}`);
  }
  // Sign-in buttons build the right /auth/start URLs.
  {
    const { tab, context } = await open("/dashboard/sign-in?returnTo=/dashboard/developer", { signedOut: true });
    const urls = [];
    await tab.route("**/auth/start**", (route) => {
      urls.push(new URL(route.request().url()).pathname + new URL(route.request().url()).search);
      route.fulfill({ status: 204 });
    });
    await tab.getByRole("button", { name: "Continue with Google" }).click();
    await tab.waitForTimeout(400);
    const status = await tab.getByRole("status").filter({ hasText: "Taking you to Google" }).count();
    const disabled = await tab.getByRole("button", { name: "Continue with Apple" }).isDisabled();
    await tab.goto(`${origin}/dashboard/sign-in`, { waitUntil: "networkidle" });
    await tab.getByRole("button", { name: "Continue with Apple" }).click();
    await tab.waitForTimeout(400);
    check("sign-in Google URL", urls[0] === "/auth/start?provider=google&returnTo=%2Fdashboard%2Fdeveloper", urls[0]);
    check("sign-in Apple URL", urls[1] === "/auth/start?provider=apple&returnTo=%2Fdashboard", urls[1]);
    check("sign-in shows the wait and disables both buttons", status === 1 && disabled);
    await context.close();
  }
  // A signed-out visit goes to sign-in with the return path; signing in comes back.
  {
    const { tab, context } = await open(CALL, { signedOut: true });
    const url = new URL(tab.url());
    check("signed-out page redirects to sign-in", url.pathname === "/dashboard/sign-in" && url.searchParams.get("returnTo") === CALL, url.pathname + url.search);
    await tab.getByRole("button", { name: "Continue with Google" }).click();
    await tab.waitForURL(`**${CALL}`, { timeout: 5000 }).catch(() => {});
    await tab.waitForLoadState("networkidle");
    check("sign-in returns to the page", new URL(tab.url()).pathname === CALL && (await tab.getByRole("heading", { name: /^Q9 team/, level: 1 }).count()) === 1, tab.url());
    await context.close();
  }
  // Navigation and keyboard order.
  {
    const { tab, context } = await open("/dashboard");
    const order = [];
    await tab.locator("body").focus();
    for (let i = 0; i < 9; i++) {
      await tab.keyboard.press("Tab");
      order.push(await focused(tab));
    }
    check("keyboard order on Home", order.slice(0, 6).join(" | ") === "Chalk, Home | Home | Developer | Account: Hasan Shoaib | Start a call | Join with a link", order.join(" | "));
    await tab.getByRole("link", { name: /^Q9 team/ }).click();
    await tab.waitForURL(`**${CALL}`);
    await tab.waitForLoadState("networkidle");
    await tab.waitForTimeout(600);
    check("Home row opens the call", (await tab.getByRole("heading", { name: /^Q9 team/, level: 1 }).count()) === 1);
    await tab
      .getByRole("link", { name: /^Session/ })
      .first()
      .click();
    await tab.waitForURL(`**${CALL}/session/**`);
    await tab.waitForLoadState("networkidle");
    await tab.waitForTimeout(600);
    check("Session row opens the past session", (await tab.getByRole("heading", { name: /^Session on/ }).count()) === 1);
    await tab.getByRole("link", { name: "Q9 team" }).click();
    await tab.waitForURL(`**${CALL}`);
    await tab.getByRole("link", { name: "Developer" }).click();
    await tab.waitForURL("**/dashboard/developer");
    await tab.waitForLoadState("networkidle");
    await tab.waitForTimeout(600);
    check("top bar opens Developer", (await tab.getByRole("heading", { name: "Developer", level: 1 }).count()) === 1);
    await context.close();
  }
  for (const [count, text] of [
    [0, "Nobody is in the call right now."],
    [1, "Nora is in the call."],
    [3, "Nora, Akash and Sofia are in the call."],
  ]) {
    const { tab, context } = await open(CALL, { set: `live=1&liveParticipants=${count}` });
    const banner = tab.getByRole("status").filter({ hasText: "Live now" });
    check(`live call with ${count} participants has accurate copy`, (await banner.getByText(text, { exact: false }).count()) === 1 && !(await tab.locator("body").textContent()).includes("People are in the call"));
    check(`live call with ${count} participants keeps Live now and Join`, (await banner.getByText("Live now", { exact: true }).count()) === 1 && (await tab.getByRole("link", { name: "Join call", exact: true }).isVisible()));
    await context.close();
  }
  // Theme switch from the account menu, kept across a reload.
  {
    const { tab, context } = await open("/dashboard");
    await tab.locator(".avb").click();
    await tab.getByRole("button", { name: "Light" }).click();
    await tab.waitForTimeout(300);
    const after = await tab.locator(".site").getAttribute("data-chalk-theme");
    await tab.reload({ waitUntil: "networkidle" });
    const reloaded = await tab.locator(".site").getAttribute("data-chalk-theme");
    check("theme switch to light, kept after reload", after === "light" && reloaded === "light", `${after}/${reloaded}`);
    await tab.locator(".avb").click();
    await tab.keyboard.press("Escape");
    check("account menu Esc returns focus", (await focused(tab)) === "Account: Hasan Shoaib");
    await context.close();
  }
  // Dialogs: focus trap and Esc.
  {
    const { tab, context } = await open("/dashboard");
    await dialogCheck(tab, "Join with a link", () => tab.getByRole("button", { name: "Join with a link" }).click(), "Join with a link");
    await dialogCheck(tab, "Your call is ready", () => tab.getByRole("button", { name: "Start a call" }).click(), "Start a call");
    await dialogCheck(tab, "Rename (Home)", async () => {
      await tab.getByRole("button", { name: "More actions for Q9 team" }).click();
      await tab.getByRole("menuitem", { name: "Rename" }).click();
    });
    await context.close();
  }
  {
    const { tab, context } = await open("/dashboard/developer");
    await dialogCheck(tab, "Create API key", () => tab.getByRole("button", { name: "Create API key" }).click(), "Create API key");
    await dialogCheck(tab, "Add website", () => tab.getByRole("button", { name: "Add website" }).click(), "Add website");
    await dialogCheck(tab, "Remove website", () => tab.getByRole("button", { name: "Remove https://app.q9labs.ai" }).click(), "Remove https://app.q9labs.ai");
    await dialogCheck(tab, "Add endpoint", () => tab.getByRole("button", { name: "Add endpoint" }).click(), "Add endpoint");
    await dialogCheck(tab, "Rotate signing secret", () => tab.getByRole("button", { name: "Rotate secret" }).click(), "Rotate secret");
    await dialogCheck(tab, "Rotate key", async () => {
      await tab.getByRole("button", { name: "Actions for Staging" }).click();
      await tab.getByRole("menuitem", { name: "Rotate secret" }).click();
    });
    await dialogCheck(tab, "Revoke key", async () => {
      await tab.getByRole("button", { name: "Actions for Staging" }).click();
      await tab.getByRole("menuitem", { name: "Revoke key" }).click();
    });
    // Create a key: the secret shows once, and the list reloads.
    await tab.getByRole("button", { name: "Create API key" }).click();
    await tab.getByLabel("Name", { exact: true }).fill("Production server");
    await tab.locator("[role=dialog] button[type=submit]").click();
    await tab.waitForTimeout(800);
    const secret = await tab.locator(".secret .linkbox").textContent();
    await dialogCheck(tab, "Secret", async () => {}, null);
    check("create key shows the secret once and lists the key", secret?.startsWith("chalk_sk_") && (await tab.getByText("Production server").count()) === 1, secret ?? "");
    await context.close();
  }
  // The CSRF header on every POST, and the Origin.
  {
    await fixture("reset");
    const { tab, context } = await open(CALL);
    await tab.getByRole("button", { name: "Anyone with the link" }).click();
    await tab.waitForTimeout(500);
    await tab.goto(`${origin}/dashboard/developer`, { waitUntil: "networkidle" });
    await tab.getByRole("button", { name: "Send test event" }).click();
    await tab.waitForTimeout(600);
    const log = await fixture("log");
    const posts = log.filter((entry) => entry.method === "POST");
    check("every POST carries the CSRF token and Origin", posts.length >= 2 && posts.every((entry) => entry.csrf === "fixture-csrf-hasan" && entry.origin === origin), posts.map((entry) => `${entry.path}:${entry.csrf}`).join(", "));
    await context.close();
  }
  // An expired sealed session requires a fresh sign-in, without refresh or read retries.
  {
    const { tab, context } = await open("/dashboard", { set: "expire=1" });
    const log = await fixture("log");
    const refreshes = log.filter((entry) => entry.path === "/auth/refresh").length;
    const reads = log.filter((entry) => entry.path === "/dashboard-api/home").length;
    check(
      "expired session returns to sign-in without refresh or retry",
      refreshes === 0 && reads <= 1 && new URL(tab.url()).pathname === "/dashboard/sign-in" && (await tab.getByRole("button", { name: "Continue with Google" }).count()) === 1,
      `refreshes=${refreshes} reads=${reads} path=${new URL(tab.url()).pathname}`,
    );
    await context.close();
  }
  // Error and rate-limit messages.
  {
    const { tab, context } = await open("/dashboard", { set: "fail=home" });
    check("load error shows a retryable panel", (await tab.getByRole("alert").filter({ hasText: "Couldn’t load your calls" }).count()) === 1);
    await fixture("set?fail=");
    await tab.getByRole("button", { name: "Try again" }).click();
    await tab.waitForTimeout(600);
    check("Try again reloads", (await tab.getByText("Q9 team").count()) >= 1);
    await context.close();
  }
  {
    const { tab, context } = await open("/dashboard/developer", { set: "limit=developer" });
    check("rate limit says how long to wait", (await tab.getByText("Chalk is getting a lot of requests. Try again in 60 seconds.").count()) === 1);
    await context.close();
  }
  {
    const { tab, context } = await open(CALL, { set: "limit=set-admission" });
    await tab.getByRole("button", { name: "Anyone with the link" }).click();
    await tab.waitForTimeout(500);
    check("rate-limited action shows a toast with the wait", (await tab.locator(".toast").filter({ hasText: "Try again in 60 seconds" }).count()) === 1);
    await context.close();
  }
  {
    const { tab, context } = await open("/dashboard/developer", { set: "freshSignIn=revoke-key" });
    await tab.getByRole("button", { name: "Actions for Staging" }).click();
    await tab.getByRole("menuitem", { name: "Revoke key" }).click();
    await tab.locator("[role=alertdialog] .btn.dz").click();
    await tab.waitForTimeout(500);
    check("fresh sign-in requirement is explained", (await tab.locator(".toast").filter({ hasText: "Sign in again to make this change" }).count()) === 1);
    await context.close();
  }
  // Transcript seek and search on the past session.
  {
    const { tab, context } = await open(`${CALL}/session/${uuid(0x200)}`);
    await tab.getByLabel("Search transcript").fill("launch");
    const count = await tab.locator(".tline").count();
    await tab.locator(".tline").first().click();
    await tab.waitForTimeout(500);
    const time = await tab.locator(".ptime").textContent();
    check("transcript search filters and a line seeks the player", count === 3 && time?.startsWith("00:41"), `${count} lines, ${time}`);
    await context.close();
  }
  // Round 2: what the new server fields and actions send and show.
  const posted = async (action) => (await fixture("log")).filter((entry) => entry.method === "POST" && entry.body?.action === action);
  {
    const { tab, context } = await open("/dashboard/developer");
    await dialogCheck(tab, "Edit events", () => tab.getByRole("button", { name: "Edit events" }).click(), "Edit events");
    await tab.getByRole("button", { name: "Edit events" }).click();
    await tab.getByRole("checkbox", { name: "transcript.completed" }).check();
    await tab.locator("[role=dialog] button[type=submit]").click();
    await tab.waitForTimeout(800);
    const [update] = await posted("update-webhook");
    const body = update?.body ?? {};
    check("edit events sends events and revision, never the URL", Boolean(update) && !("url" in body) && !("name" in body) && body.revision === 3 && body.eventTypes?.includes("transcript.completed") && update.csrf === "fixture-csrf-hasan", JSON.stringify(body));
    check("edited events show on the endpoint", (await tab.locator(".chip", { hasText: "transcript.completed" }).count()) === 1 && (await tab.getByRole("dialog").count()) === 0);
    check("keys show Last used", (await tab.getByRole("columnheader", { name: "Last used" }).count()) === 1 && (await tab.getByRole("cell", { name: "2 minutes ago" }).count()) === 1);
    check("deliveries show event, response and attempts", (await tab.getByRole("cell", { name: "401" }).count()) === 1 && (await tab.getByRole("cell", { name: "episode.ended" }).count()) === 1);
    await context.close();
  }
  {
    const { tab, context } = await open(`${CALL}/session/${uuid(0x200)}`, { set: "transcript=none" });
    const button = tab.getByRole("button", { name: "Make a transcript in English" });
    const offered = await button.count();
    await button.click();
    await tab.waitForTimeout(800);
    const [create] = await posted("create-transcript");
    check("transcript action sends one explicit language", offered === 1 && JSON.stringify(create?.body?.languages) === '["en"]' && create.body.recordingId === uuid(0x800) && create.csrf === "fixture-csrf-hasan", JSON.stringify(create?.body ?? null));
    check("transcript action leaves the panel processing", (await tab.getByText("The transcript follows the recording.").count()) === 1);
    await context.close();
  }
  {
    const { tab, context } = await open(`${CALL}/session/${uuid(0x200)}`);
    const you = await tab.locator(".who").getByText("(you)").count();
    const speakers = await tab.locator(".tline b").count();
    await context.close();
    const other = await open(`${CALL}/session/${uuid(0x203)}`);
    const youElsewhere = await other.tab.locator(".who").getByText("(you)").count();
    await other.context.close();
    check("(you) only on the owner's current seat, speakers on every line", you === 1 && youElsewhere === 0 && speakers === 16, `you=${you}, elsewhere=${youElsewhere}, speakers=${speakers}`);
  }
  {
    const { tab, context } = await open("/dashboard");
    await tab.getByRole("button", { name: "Start a call" }).click();
    await tab.waitForTimeout(900);
    const [create] = await posted("create-call");
    check("Start a call sends no name", Boolean(create) && !("name" in create.body), JSON.stringify(create?.body ?? null));
    check("the new call's link shows in the ready dialog", (await tab.getByRole("dialog").locator(".linkbox").textContent())?.includes("chalkmeet.com/space/call-") === true);
    const roboto = await tab.evaluate(() => [...document.querySelectorAll("link[rel=stylesheet]")].some((link) => link.href.includes("Roboto")));
    check("Roboto is not loaded off the sign-in page", !roboto);
    await context.close();
  }
  {
    const { tab, context } = await open("/dashboard/sign-in", { signedOut: true, set: "signInError=1" });
    const roboto = await tab.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('500 14px "Roboto"', "Continue with Google") && [...document.fonts].some((font) => font.family.replace(/"/g, "") === "Roboto" && font.status === "loaded");
    });
    check("sign-in loads Roboto 500 for the Google label", roboto);
    await tab.getByRole("button", { name: "Continue with Google" }).click();
    await tab.waitForURL("**failed=google**", { timeout: 5000 }).catch(() => {});
    await tab.waitForTimeout(500);
    const url = new URL(tab.url());
    check("failed sign-in lands on /dashboard/sign-in?failed=google with the alert", url.pathname === "/dashboard/sign-in" && url.searchParams.get("failed") === "google" && (await tab.getByRole("alert").filter({ hasText: "Google sign-in didn’t finish" }).count()) === 1, url.pathname + url.search);
    await context.close();
  }
  // Sign out.
  {
    const { tab, context } = await open("/dashboard");
    await tab.locator(".avb").click();
    await tab.getByRole("menuitem", { name: "Sign out" }).click();
    await tab.waitForURL("**/dashboard/sign-in**", { timeout: 4000 }).catch(() => {});
    check("sign out goes to sign-in", new URL(tab.url()).pathname === "/dashboard/sign-in", tab.url());
    await context.close();
  }
} finally {
  await browser.close();
  await fixture("reset");
  console.log(results.join("\n"));
  console.log(errors.length ? `CONSOLE ERRORS:\n${[...new Set(errors)].join("\n")}` : "no console errors");
}

if (results.some((result) => result.startsWith("FAIL"))) process.exitCode = 1;
