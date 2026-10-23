import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertStopped, signalWhenReady, stubbornCommand, zombieCommand } from "./signal-test.mjs";

for (const firstExit of [0, 17]) {
  test(`service gates use fresh databases and stop on exit ${firstExit}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "chalk-postgres-isolation-"));
    const write = (file, source) => writeFileSync(path.join(root, file), source, { mode: 0o755 });
    try {
      for (const directory of ["scripts/gates", "apps/api/scripts", "bin"]) mkdirSync(path.join(root, directory), { recursive: true });
      for (const script of ["with-postgres.sh", "owned-command.sh"]) copyFileSync(new URL(`./${script}`, import.meta.url), path.join(root, "scripts/gates", script));
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

// A wrapper copied into a scratch root with stub services, so its signal handling runs without PostgreSQL.
function scratchRoot(context, prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, source) => writeFileSync(path.join(root, file), source, { mode: 0o755 });
  for (const directory of ["scripts/gates", "apps/api/scripts", "bin", "pg"]) mkdirSync(path.join(root, directory), { recursive: true });
  for (const script of ["with-postgres.sh", "with-sync-topology.sh", "owned-command.sh"]) copyFileSync(new URL(`./${script}`, import.meta.url), path.join(root, "scripts/gates", script));
  write("bin/docker", `#!/bin/bash\nprintf '%s\\n' "$*" >> "$TEST_SERVICE_LOG"\ncase "$1" in port) printf '127.0.0.1:%s\\n' "$PPID" ;; esac\n`);
  write("apps/api/scripts/db-migrate.sh", "#!/bin/bash\nexit 0\n");
  // with-sync-topology.sh prefers native PostgreSQL 18, so these stubs stand in for its binaries.
  write("pg/pg_config", "#!/bin/bash\necho 'PostgreSQL 18.3'\n");
  write("pg/pg_ctl", `#!/bin/bash\nprintf 'pg_ctl %s\\n' "$*" >> "$TEST_SERVICE_LOG"\n`);
  for (const binary of ["postgres", "initdb", "createdb", "pg_basebackup", "psql"]) write(`pg/${binary}`, "#!/bin/bash\nexit 0\n");
  const env = {
    ...process.env,
    PATH: `${root}/bin:${process.env.PATH}`,
    CHALK_SYNC_PG18_BIN: `${root}/pg`,
    TEST_SERVICE_LOG: `${root}/services.log`,
    TEST_READY: `${root}/ready`,
    TEST_PIDS: `${root}/pids`,
  };
  return { root, write, env };
}

test("a gate stopped with TERM exits 143 even when its command exits 0 on TERM", async (context) => {
  const { root, write, env } = scratchRoot(context, "chalk-postgres-signal-");
  // Like the BEAM, this command shuts down cleanly with status 0 when it gets TERM.
  write("gate.sh", "#!/bin/bash\ntrap 'exit 0' TERM\ntouch \"$TEST_READY\"\nsleep 10 &\nwait\n");
  const stopped = await signalWhenReady(context, { args: ["scripts/gates/with-postgres.sh", "--", "./gate.sh"], cwd: root, env, ready: env.TEST_READY, signal: "SIGTERM" });
  assert.deepEqual({ code: stopped.code, signal: stopped.signal }, { code: 143, signal: null });
});

const stubbornCases = [
  { name: "with-postgres.sh", args: ["scripts/gates/with-postgres.sh", "--", "./gate.sh"], cleanup: /^rm -f --volumes /u, cleanups: 1, signal: "SIGTERM", code: 143 },
  { name: "with-postgres.sh", args: ["scripts/gates/with-postgres.sh", "--", "./gate.sh"], cleanup: /^rm -f --volumes /u, cleanups: 1, signal: "SIGINT", code: 130 },
  { name: "with-postgres.sh in callback mode", args: ["scripts/gates/with-postgres.sh", "--api-gate-db-lane", "--", "./gate.sh"], cleanup: /^rm -f --volumes /u, cleanups: 1, signal: "SIGTERM", code: 143 },
  // Cleanup stops the primary and the standby.
  { name: "with-sync-topology.sh", args: ["scripts/gates/with-sync-topology.sh", "--", "./gate.sh"], cleanup: /^pg_ctl .* stop$/u, cleanups: 2, signal: "SIGTERM", code: 143 },
];

for (const { name, args, cleanup, cleanups, signal, code } of stubbornCases) {
  test(`${name} stops a command that ignores ${signal}, cleans up once and exits ${code}`, async (context) => {
    const { root, write, env } = scratchRoot(context, "chalk-gate-stubborn-");
    write("gate.sh", stubbornCommand);
    const stopped = await signalWhenReady(context, { args, cwd: root, env: { ...env, CHALK_GATE_STOP_GRACE_SECONDS: "1" }, ready: env.TEST_READY, signal });
    assert.deepEqual({ code: stopped.code, signal: stopped.signal }, { code, signal: null });
    assert.ok(stopped.seconds < 2.5, `the wrapper took ${stopped.seconds} seconds to stop`);
    await assertStopped(readFileSync(env.TEST_PIDS, "utf8").trim().split(" ").map(Number));
    const services = readFileSync(env.TEST_SERVICE_LOG, "utf8").trim().split("\n");
    assert.equal(services.filter((line) => cleanup.test(line)).length, cleanups);
    // The stop reads differently from a failed test: it names the gate, the signal and the time.
    const gate = `${path.basename(args[0])} ./gate.sh`;
    const name = signal.replace(/^SIG/u, "");
    assert.match(stopped.stderr, new RegExp(`^${escape(gate)}: stopped by ${name} after \\d+s; it cleans up and exits ${code}$`, "mu"));
    assert.match(stopped.stderr, new RegExp(`^${escape(gate)}: still running 1s after ${name}, so it gets KILL$`, "mu"));
  });
}

test("a slow process-table scan does not stretch the stop grace", async (context) => {
  const { root, write, env } = scratchRoot(context, "chalk-gate-slow-scan-");
  write("gate.sh", stubbornCommand);
  // Each scan of the process table takes half a second, as on a loaded machine with many processes.
  write("bin/ps", `#!/bin/bash\nsleep 0.5\nexec /bin/ps "$@"\n`);
  const stopped = await signalWhenReady(context, { args: ["scripts/gates/with-postgres.sh", "--", "./gate.sh"], cwd: root, env: { ...env, CHALK_GATE_STOP_GRACE_SECONDS: "2" }, ready: env.TEST_READY, signal: "SIGTERM" });
  assert.deepEqual({ code: stopped.code, signal: stopped.signal }, { code: 143, signal: null });
  // The grace, plus the scan that was running when it ran out, plus KILL and cleanup.
  assert.ok(stopped.seconds < 2 + 1.5, `the wrapper took ${stopped.seconds} seconds to stop with a 2-second grace`);
  // SECONDS counts whole seconds, so the command gets at least the grace less one second.
  assert.ok(stopped.seconds > 2 - 1, `the wrapper sent KILL after ${stopped.seconds} seconds of a 2-second grace`);
  assert.match(stopped.stderr, /still running 2s after TERM, so it gets KILL$/mu);
  await assertStopped(readFileSync(env.TEST_PIDS, "utf8").trim().split(" ").map(Number));
});

test("a second TERM while a gate is stopping does not cut its cleanup short", async (context) => {
  const { root, write, env } = scratchRoot(context, "chalk-gate-twice-");
  write("gate.sh", stubbornCommand);
  // Like procps ps on Linux, this ps resets the TERM ignore it inherits. Its first scan marks a file and waits,
  // so the second TERM reaches it while the wrapper checks whether the command still runs.
  const scanning = path.join(root, "scanning");
  write("bin/ps", `#!/usr/bin/perl\n$SIG{TERM} = "DEFAULT";\nif (!-e $ENV{TEST_SCANNING}) {\n  open(my $mark, ">", $ENV{TEST_SCANNING}) or die "mark: $!";\n  close $mark;\n  sleep 5;\n}\nexec "/bin/ps", @ARGV;\n`);
  const stopped = await signalWhenReady(context, { args: ["scripts/gates/with-postgres.sh", "--", "./gate.sh"], cwd: root, env: { ...env, CHALK_GATE_STOP_GRACE_SECONDS: "2", TEST_SCANNING: scanning }, ready: env.TEST_READY, signal: "SIGTERM", againWhen: scanning });
  assert.deepEqual({ code: stopped.code, signal: stopped.signal }, { code: 143, signal: null });
  // A scan the second TERM missed would wait its full 5 seconds before the wrapper could stop.
  assert.ok(stopped.seconds < 4, `the wrapper took ${stopped.seconds} seconds, so the second TERM missed the scan`);
  await assertStopped(readFileSync(env.TEST_PIDS, "utf8").trim().split(" ").map(Number));
  const services = readFileSync(env.TEST_SERVICE_LOG, "utf8").trim().split("\n");
  assert.equal(services.filter((line) => line.startsWith("rm -f --volumes ")).length, 1);
  assert.match(stopped.stderr, /still running 2s after TERM, so it gets KILL$/mu);
});

test("a stopped run of several gates stops the running gate and starts no more", async (context) => {
  const { root, write, env } = scratchRoot(context, "chalk-gate-several-");
  write("gate.sh", stubbornCommand);
  write("second.sh", '#!/bin/bash\ntouch "$TEST_SECOND"\n');
  const second = path.join(root, "second-ran");
  // Only the outer wrapper is in the group that gets TERM; each gate runs in a wrapper of its own.
  const stopped = await signalWhenReady(context, { args: ["scripts/gates/with-postgres.sh", "./gate.sh", "./second.sh"], cwd: root, env: { ...env, CHALK_GATE_STOP_GRACE_SECONDS: "1", TEST_SECOND: second }, ready: env.TEST_READY, signal: "SIGTERM" });
  assert.deepEqual({ code: stopped.code, signal: stopped.signal }, { code: 143, signal: null });
  await assertStopped(readFileSync(env.TEST_PIDS, "utf8").trim().split(" ").map(Number));
  const services = readFileSync(env.TEST_SERVICE_LOG, "utf8").trim().split("\n");
  assert.equal(services.filter((line) => line.startsWith("rm -f --volumes ")).length, 1);
  assert.equal(existsSync(second), false);
  assert.doesNotMatch(stopped.stderr, /with-postgres\.sh \.\/gate\.sh \.\/second\.sh: still running/u);
});

test("a stop grace that is not a whole number fails before any database starts", (context) => {
  const { root, env } = scratchRoot(context, "chalk-gate-grace-");
  const result = spawnSync("bash", ["scripts/gates/with-postgres.sh", "--", "true"], { cwd: root, encoding: "utf8", timeout: 10_000, env: { ...env, CHALK_GATE_STOP_GRACE_SECONDS: "0.5" } });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /CHALK_GATE_STOP_GRACE_SECONDS must be a whole number of seconds/u);
  assert.equal(existsSync(env.TEST_SERVICE_LOG), false);
});

test("a command whose process group holds only a zombie stops without waiting out the grace period", async (context) => {
  // The holder is outside the group the wrapper stops; ending it lets the zombie be reaped. This hook
  // runs before the scratch root is removed, because hooks run in the order they were added.
  let pids;
  context.after(() => {
    if (pids === undefined || !existsSync(pids)) return;
    process.kill(Number(readFileSync(pids, "utf8").split(" ")[0]), "SIGKILL");
  });
  const { root, write, env } = scratchRoot(context, "chalk-gate-zombie-");
  pids = env.TEST_PIDS;
  write("gate.pl", zombieCommand);
  const stopped = await signalWhenReady(context, { args: ["scripts/gates/with-postgres.sh", "--", "./gate.pl"], cwd: root, env: { ...env, CHALK_GATE_STOP_GRACE_SECONDS: "5" }, ready: env.TEST_READY, signal: "SIGTERM" });
  assert.deepEqual({ code: stopped.code, signal: stopped.signal }, { code: 143, signal: null });
  assert.ok(stopped.seconds < 3, `the wrapper waited ${stopped.seconds} seconds for a zombie`);
  assert.doesNotMatch(stopped.stderr, /gets KILL/u);
});

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
