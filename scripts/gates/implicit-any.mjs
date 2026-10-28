#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export function implicitAnyIsForbidden(options) {
  return options.noImplicitAny ?? options.strict ?? false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => /(?:^|\/)tsconfig[^/]*\.json$/u.test(file));
  const failures = [];
  if (!files.length) failures.push("No TypeScript configurations were found.");
  for (const file of files) {
    const diagnostics = [];
    const config = ts.getParsedCommandLineOfConfigFile(file, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
    if (!config) failures.push(`${file}: could not read TypeScript configuration`);
    else {
      if (!implicitAnyIsForbidden(config.options)) failures.push(`${file}: strict/noImplicitAny does not forbid implicit any`);
      diagnostics.push(...config.errors);
    }
    for (const diagnostic of diagnostics) failures.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log(`Implicit any is forbidden in ${files.length} TypeScript configurations.`);
}
