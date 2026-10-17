import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stubCommands = `
set -euo pipefail
work=/test-only
snap() { if [[ "$1" == list ]]; then [[ "$SNAP_PRESENT" == 1 ]]; else echo SNAP_STARTED; fi; }
function dpkg-query() { if [[ "$DEB_PRESENT" == 1 ]]; then echo 'install ok installed'; else return 1; fi; }
systemctl() { echo DEB_STARTED; }
curl() { echo DEB_DOWNLOADED; }
dpkg() { echo DEB_INSTALLED; }
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
