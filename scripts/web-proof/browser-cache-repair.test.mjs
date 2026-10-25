import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, accessSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
const { ensurePlaywrightBrowsers } = await import(process.env.BROWSER_REPAIR_MODULE_PATH ? pathToFileURL(process.env.BROWSER_REPAIR_MODULE_PATH).href : new URL("../ensure-playwright-browsers.mjs", import.meta.url).href);

const cache = mkdtempSync(join(tmpdir(), "chalk-browser-repair-"));
const previousCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
after(() => {
  if (previousCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = previousCache;
  rmSync(cache, { recursive: true, force: true });
});

const sdk = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url));
const runtimes = Object.fromEntries(
  [
    ["sdk", createRequire(sdk.resolve("playwright"))],
    ["engine", createRequire(import.meta.resolve("@e2e-dev/web"))],
  ].map(([name, requireRuntime]) => {
    const core = dirname(requireRuntime.resolve("playwright-core/package.json"));
    const {
      registry: { registry },
    } = requireRuntime(join(core, "lib/coreBundle.js"));
    return [name, { cli: join(core, "cli.js"), registry, entries: ["chromium", "chromium-headless-shell"].map((browser) => registry.findExecutable(browser)) }];
  }),
);

function seed(runtime, poisoned = true) {
  rmSync(cache, { recursive: true, force: true });
  for (const [name, { entries }] of Object.entries(runtimes)) {
    for (const entry of entries) {
      mkdirSync(entry.directory, { recursive: true });
      writeFileSync(join(entry.directory, "INSTALLATION_COMPLETE"), "");
      if (name !== runtime || !poisoned) writeExecutable(entry);
    }
  }
}

function writeExecutable(entry) {
  mkdirSync(dirname(entry.executablePath()), { recursive: true });
  writeFileSync(entry.executablePath(), "healthy browser", { mode: 0o755 });
}

function assertOtherRuntimeHealthy(runtime) {
  const other = runtimes[runtime === "sdk" ? "engine" : "sdk"];
  for (const entry of other.entries) {
    assert.equal(readFileSync(entry.executablePath(), "utf8"), "healthy browser");
    assert.ok(existsSync(join(entry.directory, "INSTALLATION_COMPLETE")));
  }
}

function processes(runInstaller) {
  return (command, args, options) => {
    if (args[0] !== "-e") return runInstaller(command, args, options);
    const path = args.at(-1);
    return { status: existsSync(path) && readFileSync(path, "utf8") === "healthy browser" ? 0 : 1, stderr: "fixture browser cannot launch" };
  };
}

for (const runtime of ["sdk", "engine"]) {
  const { entries, cli } = runtimes[runtime];
  test(`${runtime}: repairs a marker-only cache and preserves the other runtime`, () => {
    seed(runtime);
    assert.ok(entries.every((entry) => existsSync(join(entry.directory, "INSTALLATION_COMPLETE"))));
    assert.ok(entries.every((entry) => !existsSync(entry.executablePath())));
    let calls = 0;
    const runInstaller = (command, args, options) => {
      calls += 1;
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [cli, "install", "chromium"]);
      assert.equal(options.env.PLAYWRIGHT_SKIP_BROWSER_GC, "1");
      assert.ok(
        entries.every((entry) => !existsSync(join(entry.directory, "INSTALLATION_COMPLETE"))),
        "repair must invalidate the markers before invoking the installer",
      );
      assertOtherRuntimeHealthy(runtime);
      for (const entry of entries) writeExecutable(entry);
      return { status: 0 };
    };
    ensurePlaywrightBrowsers(runtime, ["chromium"], processes(runInstaller));
    for (const entry of entries) {
      assert.ok(existsSync(entry.executablePath()), `${runtime} workflow left a poisoned executable missing: ${entry.executablePath()}`);
      accessSync(entry.executablePath(), constants.X_OK);
    }
    assert.equal(calls, 1);
    assertOtherRuntimeHealthy(runtime);
  });

  test(`${runtime}: an incomplete reinstall fails before proof`, () => {
    seed(runtime);
    assert.throws(
      () =>
        ensurePlaywrightBrowsers(
          runtime,
          ["chromium"],
          processes(() => ({ status: 0 })),
        ),
      /browsers still cannot launch after cache repair/,
    );
    assertOtherRuntimeHealthy(runtime);
  });

  test(`${runtime}: healthy cached executables do not invoke the installer`, () => {
    seed(runtime, false);
    ensurePlaywrightBrowsers(
      runtime,
      ["chromium"],
      processes(() => assert.fail("healthy cache must not reinstall")),
    );
    assertOtherRuntimeHealthy(runtime);
  });

  test(`${runtime}: a missing headless shell does not remove healthy full Chromium`, () => {
    seed(runtime, false);
    const [full, shell] = entries;
    rmSync(shell.executablePath());
    ensurePlaywrightBrowsers(
      runtime,
      ["chromium"],
      processes(() => {
        assert.equal(readFileSync(full.executablePath(), "utf8"), "healthy browser");
        assert.ok(existsSync(join(full.directory, "INSTALLATION_COMPLETE")));
        assert.ok(!existsSync(join(shell.directory, "INSTALLATION_COMPLETE")));
        writeExecutable(shell);
        return { status: 0 };
      }),
    );
    assertOtherRuntimeHealthy(runtime);
  });
}

test("SDK multi-browser repair preserves healthy Chromium", () => {
  seed("sdk", false);
  const names = ["firefox", "webkit"];
  const entries = names.map((name) => runtimes.sdk.registry.findExecutable(name));
  for (const entry of entries) {
    mkdirSync(entry.directory, { recursive: true });
    writeFileSync(join(entry.directory, "INSTALLATION_COMPLETE"), "");
  }
  ensurePlaywrightBrowsers(
    "sdk",
    names,
    processes((command, args) => {
      assert.deepEqual(args, [runtimes.sdk.cli, "install", ...names]);
      for (const entry of entries) {
        assert.ok(!existsSync(join(entry.directory, "INSTALLATION_COMPLETE")));
        writeExecutable(entry);
      }
      return { status: 0 };
    }),
  );
  for (const entry of runtimes.sdk.entries) assert.equal(readFileSync(entry.executablePath(), "utf8"), "healthy browser");
  assertOtherRuntimeHealthy("sdk");
});

for (const runtime of ["sdk", "engine"]) {
  for (const poison of ["zero-byte", "truncated-tar"]) {
    test(`${runtime}: real Playwright launch rejects a ${poison} executable even after a no-op repair`, () => {
      seed(runtime, false);
      const { entries, cli } = runtimes[runtime];
      for (const entry of entries) writeFileSync(entry.executablePath(), Buffer.alloc(0), { mode: 0o755 });
      if (poison === "truncated-tar") {
        const shell = entries[1];
        const archiveRoot = join(cache, "archive-seed");
        const binary = relative(cache, shell.executablePath());
        mkdirSync(dirname(join(archiveRoot, binary)), { recursive: true });
        writeFileSync(join(archiveRoot, binary), Buffer.alloc(4096), { mode: 0o755 });
        const archive = join(cache, "complete.tar");
        const created = spawnSync("tar", ["--format=ustar", "-cf", archive, "-C", archiveRoot, binary], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
        assert.equal(created.status, 0);
        const truncated = join(cache, "truncated.tar");
        writeFileSync(truncated, readFileSync(archive).subarray(0, 512));
        const restored = spawnSync("tar", ["-xf", truncated, "-C", cache]);
        assert.notEqual(restored.status, 0);
        // BSD tar preallocates the declared size; normalize GNU tar's zero-length result to that same poisoned state.
        if (readFileSync(shell.executablePath()).length === 0) writeFileSync(shell.executablePath(), Buffer.alloc(4096));
        assert.equal(readFileSync(shell.executablePath()).length, 4096);
      }
      let repairs = 0;
      const boundary = (command, args, options) => {
        if (args[0] === "-e") return spawnSync(command, args, options);
        repairs += 1;
        assert.deepEqual(args, [cli, "install", "chromium"]);
        for (const entry of entries) {
          assert.ok(!existsSync(join(entry.directory, "INSTALLATION_COMPLETE")));
          mkdirSync(dirname(entry.executablePath()), { recursive: true });
          writeFileSync(entry.executablePath(), Buffer.alloc(4096), { mode: 0o755 });
        }
        return { status: 0 };
      };
      assert.throws(() => ensurePlaywrightBrowsers(runtime, ["chromium"], boundary), /browsers still cannot launch after cache repair/);
      assert.equal(repairs, 1);
      assertOtherRuntimeHealthy(runtime);
    });
  }
}
