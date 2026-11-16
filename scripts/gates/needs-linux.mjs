#!/usr/bin/env node
// Stands in for a gate lane whose command is a bash script or needs Linux services, when the gate runs on Windows.
//
//   node scripts/gates/needs-linux.mjs <lane>
const lane = process.argv[2] ?? "this lane";
console.error(`The ${lane} lane runs bash scripts and Linux services, so it does not run on Windows. Push the branch: the Gate workflow runs it on Linux.`);
process.exit(1);
