import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve("wrangler/package.json"))("miniflare");

test("Pages serves a single cache policy for fonts, vendor assets and HTML", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "chalk-asset-headers-"));
  let runtime;
  try {
    const cases = [
      ["/fonts/site.css", "public, max-age=86400, must-revalidate"],
      ["/chalk-whiteboard/0.18.1/index.css", "public, max-age=31536000, immutable"],
      ["/chalk-mathjax/4.1.3/tex-svg.js", "public, max-age=31536000, immutable"],
      ["/assets/app.js", "public, max-age=31536000, immutable"],
      ["/", "public, max-age=0, s-maxage=0, must-revalidate"],
    ];
    await writeFile(resolve(directory, "_headers"), await readFile(resolve(import.meta.dirname, "../../public/_headers")));
    for (const [path] of cases) {
      const file = resolve(directory, path === "/" ? "index.html" : path.slice(1));
      await mkdir(resolve(file, ".."), { recursive: true });
      await writeFile(file, "asset");
    }
    runtime = new Miniflare({ modules: true, script: "export default { fetch(request, env) { return env.ASSETS.fetch(request) } }", compatibilityDate: "2026-07-01", assets: { directory, binding: "ASSETS" } });
    for (const [path, policy] of cases) {
      const response = await runtime.dispatchFetch(`http://chalk.test${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), policy, path);
    }
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
