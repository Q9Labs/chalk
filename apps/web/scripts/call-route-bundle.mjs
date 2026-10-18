import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { serveBuild } from "./call-performance-server.mjs";

// The real site's router/auth shell is measured separately from the fixture entry.
// No login or live call is needed to load the public call route's production JS.
export async function measureRouteBundle({ browser, web }) {
  const server = await serveBuild(resolve(web, "dist/client"), "_shell/index.html");
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await context.newPage();
    const resources = new Map();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (!["script", "stylesheet"].includes(response.request().resourceType())) return;
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
      resources.set(response.url(), response);
    });
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      // No test traffic goes to production API, analytics, or font providers.
      return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    });
    await page.goto(`${origin}/space/performance-budget`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Join", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    if (errors.length) throw new Error(`Production call route: ${errors.join("; ")}`);
    let routeJsGzipKiB = 0;
    let routeCssGzipKiB = 0;
    const loaded = [];
    for (const [url, response] of resources) {
      const gzipKiB = gzipSync(await response.body(), { level: 9 }).length / 1024;
      if (response.request().resourceType() === "script") routeJsGzipKiB += gzipKiB;
      else routeCssGzipKiB += gzipKiB;
      loaded.push({ path: url.replace(origin, ""), gzipKiB });
    }
    if (!routeJsGzipKiB || !routeCssGzipKiB) throw new Error("Production call route loaded no JS or CSS");
    return { routeJsGzipKiB, routeCssGzipKiB, loaded };
  } finally {
    await context.close();
    await new Promise((done) => server.close(done));
  }
}
