import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = new URL("./install-pinned-tool.sh", import.meta.url).pathname;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "install-pinned-tool-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // A curl that records each call and fails like a GitHub 504, so a test sees every network attempt.
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\necho "$*" >> "${root}/curl-calls"\nexit 22\n`);
  chmodSync(join(bin, "curl"), 0o755);
  return { root, bin, cache: join(root, "cache") };
}

function install({ root, bin, cache }, ...candidates) {
  return spawnSync("bash", [script, ...candidates], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, CHALK_TOOL_CACHE: cache },
  });
}

function curlCalls({ root }) {
  try {
    return readFileSync(join(root, "curl-calls"), "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
}

test("a cache hit makes no network call", () => {
  const space = workspace();
  mkdirSync(space.cache);
  writeFileSync(join(space.cache, `${sha256("tool")}-tool.tar.gz`), "tool");
  const result = install(space, `${sha256("tool")}=tool.tar.gz=https://github.com/example/tool.tar.gz`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(space.cache, `${sha256("tool")}-tool.tar.gz`));
  assert.equal(curlCalls(space), 0);
});

test("a cached copy of the second source also avoids the network", () => {
  const space = workspace();
  mkdirSync(space.cache);
  writeFileSync(join(space.cache, `${sha256("deb")}-tool.deb`), "deb");
  const result = install(space, `${sha256("archive")}=tool.tar.gz=https://github.com/example/tool.tar.gz`, `${sha256("deb")}=tool.deb=https://packages.example.com/tool.deb`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /tool\.deb$/);
  assert.equal(curlCalls(space), 0);
});

test("a corrupt cached file is not trusted", () => {
  const space = workspace();
  mkdirSync(space.cache);
  writeFileSync(join(space.cache, `${sha256("tool")}-tool.tar.gz`), "tampered");
  const result = install(space, `${sha256("tool")}=tool.tar.gz=https://github.com/example/tool.tar.gz`);
  assert.notEqual(result.status, 0);
  assert.equal(curlCalls(space), 1);
});

test("when the first source fails the second source is used and then cached", () => {
  const space = workspace();
  const mirror = join(space.root, "mirror.deb");
  writeFileSync(mirror, "deb");
  // This curl fails on any github.com URL and serves file:// URLs, like an outage on one host only.
  writeFileSync(join(space.bin, "curl"), `#!/usr/bin/env bash\necho "$*" >> "${space.root}/curl-calls"\nfor arg in "$@"; do case "$arg" in https://github.com/*) exit 22 ;; esac; done\nexec /usr/bin/curl "$@"\n`);
  const candidates = [`${sha256("archive")}=tool.tar.gz=https://github.com/example/tool.tar.gz`, `${sha256("deb")}=tool.deb=file://${mirror}`];
  const first = install(space, ...candidates);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout.trim(), /tool\.deb$/);
  const callsAfterFirst = curlCalls(space);
  const second = install(space, ...candidates);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(curlCalls(space), callsAfterFirst);
});

test("a download that does not match the pinned checksum is rejected", () => {
  const space = workspace();
  const mirror = join(space.root, "mirror.tar.gz");
  writeFileSync(mirror, "something else");
  writeFileSync(join(space.bin, "curl"), `#!/usr/bin/env bash\nexec /usr/bin/curl "$@"\n`);
  const result = install(space, `${sha256("tool")}=tool.tar.gz=file://${mirror}`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No source produced a download/);
});
