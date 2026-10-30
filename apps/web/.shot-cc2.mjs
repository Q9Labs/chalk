import { chromium } from "playwright";
const [base, out, ...states] = process.argv.slice(2);
const exe = "/Users/macmini/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const b = await chromium.launch({ executablePath: exe });
const sizes = { laptop: [1440, 900], phone: [390, 844] };
for (const [name, [w, h]] of Object.entries(sizes)) {
  for (const spec of states) {
    const [id, ...steps] = spec.split("+");
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: name === "phone", isMobile: name === "phone" });
    const p = await ctx.newPage();
    await p.goto(`${base}/call-states.html?state=${id}`);
    await p.waitForTimeout(2500);
    for (const s of steps) {
      const [kind, rest] = s.split(":");
      const [lap, ph] = rest.split("||");
      const labels = name === "phone" && ph ? ph.split(">") : [lap];
      if (kind === "click") for (const label of labels) { await p.getByText(label, { exact: true }).or(p.getByRole("button", { name: label, exact: true })).first().click(); await p.waitForTimeout(900); }
    }
    await p.screenshot({ path: `${out}/${id}${steps.length ? "-" + steps.map((s) => s.split(":")[1].split("||")[0].replace(/\W+/g, "")).join("-") : ""}-${name}.png` });
    await ctx.close();
  }
}
await b.close();
