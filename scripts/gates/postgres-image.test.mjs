import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres-image.sh");

// A docker stub that succeeds only for the images in `works`, and records every pull.
function pull(works) {
  const directory = mkdtempSync(path.join(tmpdir(), "postgres-image-"));
  const log = path.join(directory, "pulls");
  const docker = path.join(directory, "docker");
  writeFileSync(docker, `#!/bin/sh\necho "$3" >> "${log}"\ncase "$3" in ${works.map((image) => `${image}) exit 0;;`).join(" ")} *) echo "toomanyrequests: Rate exceeded" >&2; exit 1;; esac\n`);
  chmodSync(docker, 0o700);
  const result = spawnSync("bash", ["-c", `source "${script}"; pull_postgres_image "${docker}" && echo "$postgres_image"`], {
    encoding: "utf8",
    env: { ...process.env, POSTGRES_PULL_WAIT_SECONDS: "0" },
  });
  return { status: result.status, image: result.stdout.trim(), pulls: readFileSync(log, "utf8").trim().split("\n") };
}

test("a rate limit on public.ecr.aws falls through to Docker Hub", () => {
  const result = pull(["postgres:18.3-alpine"]);
  assert.deepEqual([result.status, result.image], [0, "postgres:18.3-alpine"]);
  assert.deepEqual(result.pulls, ["public.ecr.aws/docker/library/postgres:18.3-alpine", "postgres:18.3-alpine"]);
});

test("public.ecr.aws is tried first and used when it works", () => {
  const result = pull(["public.ecr.aws/docker/library/postgres:18.3-alpine"]);
  assert.deepEqual([result.status, result.image, result.pulls.length], [0, "public.ecr.aws/docker/library/postgres:18.3-alpine", 1]);
});

test("both registries refusing the pull fails after three rounds", () => {
  const result = pull([]);
  assert.equal(result.status, 1);
  assert.equal(result.pulls.length, 6);
});
