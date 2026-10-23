import assert from "node:assert/strict";
import { test } from "node:test";
import { runWebRelease } from "./deploy-web-release.mjs";

const sha = "a".repeat(40);

function githubCommands({ watch = () => "" } = {}) {
  const calls = [];
  let requestId;
  const responses = {
    "git rev-parse HEAD": () => `${sha}\n`,
    "gh workflow run": (args) => {
      requestId = args.find((value) => value.startsWith("web_dispatch_id=")).split("=")[1];
      return "";
    },
    "gh run list": () =>
      JSON.stringify([
        { databaseId: 99, displayTitle: `Release ${sha} another-request` },
        { databaseId: 123, displayTitle: `Release ${sha} ${requestId}` },
      ]),
    "gh run watch": (args) => {
      assert.deepEqual(args, ["run", "watch", "123", "--exit-status"]);
      return watch();
    },
  };
  return {
    calls,
    async commandRunner(spec) {
      calls.push(spec);
      const key = [spec.command, ...spec.args.slice(0, 2)].join(" ");
      assert.ok(key in responses, "local releases must only dispatch and wait, without building or uploading");
      return responses[key](spec.args);
    },
  };
}

test("local production and nightly releases dispatch the existing workflow and wait for their exact run", async () => {
  for (const target of ["production", "nightly"]) {
    const runner = githubCommands();
    await runWebRelease({ arguments_: ["--target", target], commandRunner: runner.commandRunner });
    const dispatch = runner.calls[1].args;
    assert.deepEqual(dispatch.slice(0, 5), ["workflow", "run", "ci.yml", "--ref", "master"]);
    for (const input of [`target_sha=${sha}`, `managed_environment=${target}`, "release_managed=false", "deploy_managed=false", "deploy_web=true"]) assert.ok(dispatch.includes(input), input);
    assert.ok(!dispatch.includes("without_asset_retention=true"));
    assert.equal(runner.calls.at(-1).args[2], "123");
  }
});

test("bootstrap forwards only its explicit flag and a workflow failure fails the local release", async () => {
  const runner = githubCommands({
    watch: () => {
      throw new Error("workflow failed");
    },
  });
  await assert.rejects(runWebRelease({ arguments_: ["--sha", sha, "--without-asset-retention"], commandRunner: runner.commandRunner }), /workflow failed/);
  assert.ok(runner.calls[0].args.includes("without_asset_retention=true"));
});

test("dry run never dispatches and invalid destinations fail before invoking commands", async () => {
  const commandRunner = () => assert.fail("must not execute");
  await runWebRelease({ arguments_: ["--sha", sha, "--dry-run"], commandRunner });
  await assert.rejects(runWebRelease({ arguments_: ["--sha", sha, "--target", "preview"], commandRunner }), /production or nightly/);
});
