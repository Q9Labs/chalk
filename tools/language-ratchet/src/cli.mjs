#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runRatchet } from "./ratchet.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const baselinePath = path.join(repositoryRoot, "tools/language-ratchet/baseline.json");
const argumentsList = process.argv.slice(2);
const update = argumentsList.includes("--update");
const unknownArguments = argumentsList.filter((argument) => argument !== "--update");

if (unknownArguments.length > 0) {
  console.error(`Unknown argument: ${unknownArguments.join(", ")}`);
  process.exit(2);
}

try {
  process.exitCode = await runRatchet({ repositoryRoot, baselinePath, update });
} catch (error) {
  console.error(`Language ratchet setup failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 2;
}
