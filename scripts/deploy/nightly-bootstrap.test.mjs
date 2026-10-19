import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stubCommands = `
set -euo pipefail
work=/test-only
snap() { if [[ "$1" == list ]]; then [[ "$SNAP_PRESENT" == 1 ]]; else echo SNAP_STARTED; fi; }
function dpkg-query() { if [[ "$DEB_PRESENT" == 1 ]]; then echo 'install ok installed'; else return 1; fi; }
systemctl() { echo DEB_STARTED; }
curl() { echo DEB_DOWNLOADED; }
dpkg() { echo DEB_INSTALLED; }
runuser() { :; }
`;

for (const scenario of [
  { name: "starts an installed but inactive Snap agent without adding a deb", snap: "1", deb: "0", expected: "SNAP_STARTED\n" },
  { name: "starts an existing deb agent without reinstalling", snap: "0", deb: "1", expected: "DEB_STARTED\n" },
  { name: "installs one deb agent only when no agent is installed", snap: "0", deb: "0", expected: "DEB_DOWNLOADED\nDEB_INSTALLED\nDEB_STARTED\n" },
]) {
  test(scenario.name, async () => {
    const cloudInit = await readFile(new URL("../../infrastructure/nightly/host-cloud-init.yaml", import.meta.url), "utf8");
    const block = cloudInit
      .split("# Keep one installed SSM Agent, including when an existing agent is stopped.\n")[1]
      .split("      loginctl")[0]
      .replace(/^      /gm, "");
    const result = spawnSync("bash", ["-c", stubCommands + block], { encoding: "utf8", env: { ...process.env, SNAP_PRESENT: scenario.snap, DEB_PRESENT: scenario.deb } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, scenario.expected);
  });
}

test(
  "the first deployment leaves service paths readable by their runtime user",
  {
    skip: process.platform !== "linux" || process.getuid?.() !== 0,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chalk-nightly-ownership-"));
    const user = `chalktest_${randomUUID().slice(0, 8)}`;
    const home = join(directory, "home");
    const run = (command, args) => {
      const result = spawnSync(command, args, { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || `${command} failed`);
      return result.stdout.trim();
    };
    try {
      await chmod(directory, 0o755);
      run("useradd", ["--no-create-home", "--home-dir", home, user]);
      const uid = Number(run("id", ["-u", user]));
      const gid = Number(run("id", ["-g", user]));
      await mkdir(home, { mode: 0o700 });
      await chown(home, uid, gid);
      const cloudInit = await readFile(new URL("../../infrastructure/nightly/host-cloud-init.yaml", import.meta.url), "utf8");
      const setup = cloudInit.split("\n").find((line) => line.includes("runuser -u chalk -- sh -c 'umask 077; mkdir"));
      const command = setup.replaceAll("/home/chalk", home).replace("runuser -u chalk", `runuser -u ${user}`);
      const script = join(directory, "setup.sh");
      await writeFile(script, command);
      run("bash", [script]);
      // The failed nightly host had root-owned 0700 parents and chalk-owned leaves.
      for (const leaf of [".config/containers/systemd", ".config/systemd/user"]) {
        const path = join(home, leaf);
        await mkdir(path, { recursive: true, mode: 0o700 });
        await chown(path, uid, gid);
      }
      for (const relative of [".config", ".config/containers", ".config/containers/systemd", ".config/systemd", ".config/systemd/user"]) {
        const path = join(home, relative);
        const entry = await stat(path);
        assert.equal(entry.uid, uid, `${relative} belongs to the runtime user`);
        assert.equal(entry.gid, gid, `${relative} belongs to the runtime group`);
        assert.equal(entry.mode & 0o777, 0o700, `${relative} stays private`);
        run("runuser", ["-u", user, "--", "test", "-r", path]);
        run("runuser", ["-u", user, "--", "test", "-x", path]);
      }
    } finally {
      const cleanup = spawnSync("userdel", [user], { encoding: "utf8" });
      await rm(directory, { recursive: true, force: true });
      assert.ok([0, 6].includes(cleanup.status), cleanup.stderr);
    }
  },
);
