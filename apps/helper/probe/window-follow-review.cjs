const { once } = require("node:events");
const { spawn, execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");

(async () => {
  const target = spawn("./window-fixture", { stdio: ["ignore", "pipe", "inherit"] });
  const report = {};
  try {
    const [output] = await once(target.stdout, "data");
    const id = output.toString().trim();
    async function sample(label, signal) {
      if (signal) target.kill(signal);
      let value;
      for (let i = 0; i < 8; i++) {
        await delay(180);
        value = JSON.parse(execFileSync("./window-read", [id]));
      }
      return report[label] = value;
    }
    const start = await sample("initial");
    const moved = await sample("moved", "SIGUSR1");
    const resized = await sample("resized", "SIGUSR2");
    const minimized = await sample("minimized", "SIGALRM");
    const restored = await sample("afterRestore", "SIGHUP");
    const covered = await sample("thinCover", "SIGCONT");
    const uncovered = await sample("afterUncover", "SIGWINCH");
    assert(start.visible, "target not initially visible to Quartz");
    assert(moved.visible && moved.x > start.x && moved.y < start.y, "exact target move not observed");
    assert(resized.visible && resized.width > moved.width && resized.height > moved.height, "resize not observed");
    assert(!minimized.visible && restored.visible, "minimize or restore not observed");
    assert(!covered.visible && uncovered.visible, "thin overlap did not hide overlay eligibility");
  } finally {
    target.kill();
    fs.writeFileSync("window-follow-review.json", JSON.stringify(report, null, 2) + "\n");
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
