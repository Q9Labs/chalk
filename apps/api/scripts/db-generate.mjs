#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand } from "../../../scripts/lib/platform.mjs";

const apiRoot = path.resolve(import.meta.dirname, "..");

const description = `Chalk API sqlc generation helper

Usage:
  node apps/api/scripts/db-generate.mjs [command]

Commands:
  run       Generate Go query code. This is also the default.
  check     Fail if the checked-in Go query code differs from a fresh generation. Needs no database.
  describe  Describe this helper.
  help      Show this help.

Reads:
  db/schema.sql
  db/queries

Writes:
  internal/postgres/db`;

const command = process.argv[2] ?? "run";
if (["describe", "help", "-h", "--help"].includes(command)) {
  console.log(description);
  process.exit(0);
}
if (command !== "run" && command !== "check") {
  console.error(`Unknown command: ${command}\n\n${description}`);
  process.exit(2);
}

const childEnvironment = { ...process.env };
if (existsSync("/usr/local/go/bin")) childEnvironment.PATH = `/usr/local/go/bin${path.delimiter}${childEnvironment.PATH ?? ""}`;
childEnvironment.GOTOOLCHAIN = process.env.CHALK_API_GOTOOLCHAIN || "go1.26.11+auto";

process.exit(runCommand("go", ["tool", "sqlc", command === "check" ? "diff" : "generate"], { cwd: apiRoot, env: childEnvironment }));
