import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runWebRelease } from "./deploy-web-release.mjs";

const sha = "a".repeat(40);
const responses = new Map([
  ["git rev-parse HEAD", sha],
  ["node --version", "v26.10.0"],
  ["pnpm --version", "12.8.1"],
  ["pnpm exec wrangler --version", "4.107.0"],
]);

for (const behavior of ["historical uploader", "production Sync", "Worker probe failure"])
  test(`local releases preserve ${behavior}`, async (t) => {
    const historical = await mkdtemp(join(tmpdir(), "chalk-historical-web-"));
    t.after(() => rm(historical, { recursive: true, force: true }));
    const webPath = join(historical, "apps/web");
    await mkdir(join(webPath, "dist/client"), { recursive: true });
    const calls = [];
    const commandRunner = async (spec) => {
      calls.push(spec);
      const args = spec.args.join(" ");
      if (behavior === "Worker probe failure" && args.includes("prepare-vendor-store.ts")) throw new Error("Vendor Worker probe failed");
      if (behavior === "historical uploader" && args.includes("prepare-vendor-store.ts")) {
        const script = resolve(spec.cwd, spec.args[2]);
        await access(script);
        assert.equal(script, resolve(import.meta.dirname, "../../apps/web/scripts/prepare-vendor-store.ts"));
        assert.equal(spec.args[spec.args.indexOf("--directory") + 1], join(webPath, "dist/client"));
        assert.equal(spec.args.at(-1), "production");
      }
      return { stdout: responses.get(`${spec.command} ${args}`) ?? "" };
    };
    const run = () => runWebRelease({ arguments_: ["--sha", sha, "--skip-staging"], environment: { CLOUDFLARE_API_TOKEN: "local-fixture", VITE_CHALK_SYNC_URL: "wss://nightly-sync.chalkmeet.com/v1/sync" }, rootDirectory: historical, webPath, commandRunner });
    if (behavior === "Worker probe failure") {
      await assert.rejects(run(), /Vendor Worker probe failed/);
      assert.ok(!calls.some(({ args }) => args.includes("pages")));
      return;
    }
    await run();
    const build = calls.find(({ args }) => args.includes("turbo"));
    if (behavior === "production Sync") {
      assert.equal(build.env.VITE_API_URL, "https://api.chalkmeet.com");
      assert.equal(build.env.VITE_CHALK_SYNC_URL, "wss://sync.chalkmeet.com/v1/sync");
    }
    const upload = calls.findIndex(({ args }) => args.some((arg) => arg.includes("prepare-vendor-store.ts")));
    const deploy = calls.findIndex(({ args }) => args.includes("deploy"));
    assert.ok(upload >= 0 && deploy > upload);
  });
