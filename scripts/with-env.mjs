#!/usr/bin/env node
// Runs a command with variables set, the same on every platform: a package.json script cannot use `NAME=value command`
// or `${NAME:-default}` under cmd.exe.
//
//   node scripts/with-env.mjs NAME=value NAME?=default -- command args...
//
// `NAME=value` always sets the variable; `NAME?=default` sets it only when it is unset or empty.
import { runCommand } from "./lib/platform.mjs";

const separator = process.argv.indexOf("--");
const assignments = process.argv.slice(2, separator);
const [command, ...args] = process.argv.slice(separator + 1);
if (separator < 0 || command === undefined) {
  console.error("usage: with-env.mjs NAME=value NAME?=default -- command args...");
  process.exit(2);
}

const childEnvironment = { ...process.env };
for (const assignment of assignments) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?=(.*)$/s.exec(assignment);
  if (!match) {
    console.error(`with-env.mjs: "${assignment}" is not NAME=value or NAME?=default`);
    process.exit(2);
  }
  const [, name, onlyDefault, value] = match;
  if (!onlyDefault || !childEnvironment[name]) childEnvironment[name] = value;
}
process.exitCode = runCommand(command, args, { env: childEnvironment });
