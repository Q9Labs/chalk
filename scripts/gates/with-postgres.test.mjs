import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

for (const firstExit of [0, 17]) {
  test(`service gates use fresh databases and stop on exit ${firstExit}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "chalk-postgres-isolation-"));
    const write = (file, source) => writeFileSync(path.join(root, file), source, { mode: 0o755 });
    try {
      for (const directory of ["scripts/gates", "apps/api/scripts", "bin"]) mkdirSync(path.join(root, directory), { recursive: true });
      copyFileSync(new URL("./with-postgres.sh", import.meta.url), path.join(root, "scripts/gates/with-postgres.sh"));
      write(
        "bin/docker",
        `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
case "$1" in
  port) printf '127.0.0.1:%s\\n' "$PPID" ;;
esac
`,
      );
      write("apps/api/scripts/db-migrate.sh", "#!/bin/bash\nexit 0\n");
      write("first.sh", `#!/bin/bash\nprintf '%s\\n' "$CHALK_DATABASE_URL" >> "$TEST_URL_LOG"\nexit ${firstExit}\n`);
      write("second.sh", '#!/bin/bash\nprintf \'%s\\n\' "$CHALK_DATABASE_URL" >> "$TEST_URL_LOG"\n');
      const result = spawnSync("bash", ["scripts/gates/with-postgres.sh", "./first.sh", "./second.sh"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_DOCKER_LOG: `${root}/docker.log`, TEST_URL_LOG: `${root}/urls.log` },
      });
      assert.equal(result.status, firstExit, result.stderr);
      const commands = readFileSync(path.join(root, "docker.log"), "utf8").trim().split("\n");
      const urls = readFileSync(path.join(root, "urls.log"), "utf8").trim().split("\n");
      const count = firstExit === 0 ? 2 : 1;
      assert.equal(commands.filter((command) => command.startsWith("run ")).length, count);
      assert.equal(commands.filter((command) => command.startsWith("rm ")).length, count);
      assert.equal(urls.length, count);
      assert.equal(new Set(urls).size, count);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a gate stopped with TERM exits 143 even when its command exits 0 on TERM", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chalk-postgres-signal-"));
  const write = (file, source) => writeFileSync(path.join(root, file), source, { mode: 0o755 });
  try {
    for (const directory of ["scripts/gates", "apps/api/scripts", "bin"]) mkdirSync(path.join(root, directory), { recursive: true });
    copyFileSync(new URL("./with-postgres.sh", import.meta.url), path.join(root, "scripts/gates/with-postgres.sh"));
    write("bin/docker", `#!/bin/bash\ncase "$1" in port) printf '127.0.0.1:%s\\n' "$PPID" ;; esac\n`);
    write("apps/api/scripts/db-migrate.sh", "#!/bin/bash\nexit 0\n");
    // Like the BEAM, this command shuts down cleanly with status 0 when it gets TERM.
    write("gate.sh", "#!/bin/bash\ntrap 'exit 0' TERM\ntouch \"$TEST_READY\"\nsleep 10 &\nwait\n");
    const ready = path.join(root, "ready");
    const child = spawn("bash", ["scripts/gates/with-postgres.sh", "--", "./gate.sh"], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_READY: ready },
    });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    let early;
    exited.then((result) => (early = result));
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) {
      assert.equal(early, undefined, "the wrapper exited before its command started");
      assert.ok(Date.now() < deadline, "the wrapper's command did not start within 10 seconds");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.kill(-child.pid, "SIGTERM");
    assert.deepEqual(await exited, { code: 143, signal: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
