import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
