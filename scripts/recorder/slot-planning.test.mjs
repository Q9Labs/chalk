import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hasTofu = spawnSync("tofu", ["version"], { stdio: "ignore" }).status === 0;

test("a nonzero Capture floor plans only capacity metadata", { skip: !hasTofu, timeout: 30_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-slot-plan-"));
  try {
    const source = readFileSync(new URL("../../infrastructure/recorder/modules/digitalocean-recorder-capture/main.tf", import.meta.url), "utf8");
    const contract = source.slice(source.indexOf('resource "terraform_data" "runtime_capacity_contract"'));
    const inputs = { max_nodes: 10, desired_nodes: 2, region: "sgp1", node_size: "c-2", image_id: 123, image_digest: "", bootstrap_endpoint: "" };
    const variables = Object.entries(inputs)
      .map(([name, value]) => `variable "${name}" { default = ${JSON.stringify(value)} }`)
      .join("\n");
    writeFileSync(join(directory, "main.tf"), `${variables}\nlocals { pool_tag = "capture-test" }\n${contract}`);
    const run = (args) => execFileSync("tofu", [`-chdir=${directory}`, ...args], { encoding: "utf8", timeout: 20_000 });
    run(["init", "-backend=false", "-input=false", "-no-color"]);
    run(["plan", "-input=false", "-refresh=false", "-lock=false", "-out=plan"]);
    const plan = JSON.parse(run(["show", "-json", "plan"]));
    assert.equal(plan.resource_changes.length, 1);
    assert.equal(plan.resource_changes[0].type, "terraform_data");
    assert.equal(plan.resource_changes[0].change.after.input.desired_nodes, 2);
    assert.equal(plan.resource_changes[0].change.after.input.runtime_owner, "external-recorder-reconciler");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
