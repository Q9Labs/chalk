import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// The command that a wrapper runs: it ignores TERM and INT, and so does the grandchild it leaves running.
export const stubbornCommand = '#!/bin/bash\ntrap "" TERM INT\nsleep 30 &\nprintf "%s %s\\n" "$$" "$!" > "$TEST_PIDS"\ntouch "$TEST_READY"\nwait\n';

// The command that a wrapper runs: it exits on TERM and leaves only a zombie in its process group. A holder
// outside the group starts a child that joins the group and exits, and the holder never reaps it.
// TEST_PIDS gets the holder's and the zombie's pids.
export const zombieCommand = `#!/usr/bin/perl
use strict;
use warnings;
my $group = getpgrp();
$SIG{TERM} = sub { exit 0 };
pipe(my $read, my $write) or die "pipe: $!";
my $holder = fork() // die "fork: $!";
if ($holder == 0) {
  close $read;
  open(STDOUT, ">", "/dev/null") and open(STDERR, ">", "/dev/null") or die "redirect: $!";
  setpgrp(0, 0) or die "setpgrp: $!";
  my $child = fork() // die "fork: $!";
  if ($child == 0) { setpgrp(0, $group) or die "setpgrp: $!"; exit 0 }
  print {$write} "$$ $child\\n";
  close $write;
  sleep 600;
  exit 0;
}
close $write;
my $pids = <$read>;
my $child = (split " ", $pids)[1];
select(undef, undef, undef, 0.05) while \`ps -o stat= -p $child\` !~ /^\\s*Z/;
open(my $out, ">", $ENV{TEST_PIDS}) or die "pids: $!";
print {$out} $pids;
close $out;
open(my $ready, ">", $ENV{TEST_READY}) or die "ready: $!";
close $ready;
sleep 1 while 1;
`;

// Starts a wrapper in its own process group, sends the group a signal once the wrapped command is ready,
// and returns how the wrapper exited, how long it took and what it printed to stderr.
// With `againAfterMs`, the group gets the signal a second time while the wrapper is still stopping.
export async function signalWhenReady(context, { args, cwd, env, ready, signal, againAfterMs }) {
  const child = spawn("bash", args, { cwd, detached: true, stdio: ["ignore", "ignore", "pipe"], env });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })));
  // The wrapper's last stderr lines can arrive after it exits. A process that outlived it can hold the
  // pipe open, so the wait for the rest is short.
  const closed = new Promise((resolve) => child.on("close", resolve));
  let early;
  exited.then((result) => (early = result));
  // A failed assertion leaves the wrapper running, and the test runner would wait for it.
  context.after(async () => {
    if (early !== undefined) return;
    process.kill(-child.pid, "SIGKILL");
    await exited;
  });
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready)) {
    assert.equal(early, undefined, "the wrapper exited before its command started");
    assert.ok(Date.now() < deadline, "the wrapper's command did not start within 10 seconds");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const started = Date.now();
  process.kill(-child.pid, signal);
  if (againAfterMs !== undefined) {
    const again = setTimeout(() => early === undefined && process.kill(-child.pid, signal), againAfterMs);
    exited.then(() => clearTimeout(again));
  }
  const result = await exited;
  const seconds = (Date.now() - started) / 1000;
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
  return { ...result, seconds, stderr };
}

export async function assertStopped(pids) {
  const deadline = Date.now() + 2_000;
  for (const pid of pids) {
    while (isRunning(pid)) {
      assert.ok(Date.now() < deadline, `process ${pid} still runs after the wrapper exited`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

// A zombie has exited, though Linux still lets kill reach it until its parent reaps it.
function isRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
  return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
    .stdout.trim()
    .startsWith("Z");
}
