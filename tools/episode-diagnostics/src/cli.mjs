#!/usr/bin/env node
// @ts-check

import { inspectDiagnostic } from "./inspect.mjs";
import { renderDiagnosticResult } from "./render.mjs";
import { asDiagnosticInspectError } from "./errors.mjs";

const USAGE = "Usage: pnpm trace:inspect <diagnostic-reference> [--around 30s] [--branch <id>] [--format text|agent|json] [--at-cursor <cursor>] [--latest] [--query summary|focus|brief|copy-all|events|operations|graph|flame|participants|epilogue]";
const SIMPLE_QUERY_FLAGS = Object.freeze({ "--brief": "brief", "--copy-all": "copy-all", "--focus": "focus" });
const OPTION_SPECS = Object.freeze({
  "--format": { key: "format", parser: identity },
  "-f": { key: "format", parser: identity },
  "--query": { key: "query", parser: identity },
  "--view": { key: "query", parser: identity },
  "--page": { key: "query", parser: identity },
  "--around": { key: "aroundSeconds", parser: parseDuration },
  "--branch": { key: "branchId", parser: identity },
  "--branch-id": { key: "branchId", parser: identity },
  "--at-cursor": { key: "atCursor", parser: parseCursor },
  "--cursor": { key: "atCursor", parser: parseCursor },
  "--after-cursor": { key: "afterCursor", parser: parseCursor },
  "--before-cursor": { key: "beforeCursor", parser: parseCursor },
  "--limit": { key: "limit", parser: parseCursor },
  "--page-size": { key: "limit", parser: parseCursor },
});

/**
 * @param {string[]} argv
 */
export function parseCliArguments(argv) {
  const parsed = scanArguments(argv);
  if (parsed.help) return { help: true, reference: undefined, query: {} };
  validateArguments(parsed.positional, parsed.query);
  return { help: false, reference: parsed.positional[0], query: parsed.query };
}

/** @param {string[]} argv */
function scanArguments(argv) {
  const positional = [];
  const query = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    const [flag, inlineValue] = splitFlag(argument);
    const consumed = consumeOption(flag, inlineValue, argv, index, query);
    index = consumed.nextIndex;
    if (consumed.help) return { help: true, positional, query };
  }
  return { help: false, positional, query };
}

/** @param {string} argument @returns {[string, string | undefined]} */
function splitFlag(argument) {
  const separator = argument.indexOf("=");
  if (separator < 0) return [argument, undefined];
  return [argument.slice(0, separator), argument.slice(separator + 1)];
}

/**
 * @param {string} flag
 * @param {string | undefined} inlineValue
 * @param {string[]} argv
 * @param {number} index
 * @param {Record<string, any>} query
 */
function consumeOption(flag, inlineValue, argv, index, query) {
  if (isHelpFlag(flag)) return { help: true, nextIndex: index };
  const simple = simpleOption(flag);
  if (simple) {
    query[simple.key] = simple.value;
    return { help: false, nextIndex: index };
  }
  const spec = OPTION_SPECS[flag];
  if (!spec) throw new Error(`Unknown option ${flag}`);
  const option = optionValue(flag, inlineValue, argv, index);
  query[spec.key] = spec.parser(option.value, flag);
  return { help: false, nextIndex: option.nextIndex };
}

/** @param {string} flag */
function isHelpFlag(flag) {
  return flag === "--help" || flag === "-h";
}

/** @param {string} flag */
function simpleOption(flag) {
  if (flag === "--latest") return { key: "latest", value: true };
  const query = SIMPLE_QUERY_FLAGS[flag];
  if (query) return { key: "query", value: query };
  return undefined;
}

/**
 * @param {string} label
 * @param {string | undefined} inlineValue
 * @param {string[]} argv
 * @param {number} index
 */
function optionValue(label, inlineValue, argv, index) {
  let value = inlineValue;
  let nextIndex = index;
  if (value === undefined) {
    nextIndex += 1;
    value = argv[nextIndex];
  }
  if (!value || value.startsWith("-")) throw new Error(`${label} requires a value`);
  return { value, nextIndex };
}

/** @param {string[]} positional @param {Record<string, any>} query */
function validateArguments(positional, query) {
  if (positional.length !== 1) throw new Error(USAGE);
  validateFormat(query.format);
}

/** @param {unknown} format */
function validateFormat(format) {
  if (format !== undefined && !["text", "agent", "json"].includes(format)) throw new Error("Format must be text, agent, or json");
}

/**
 * @param {string} value
 */
function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/u.exec(value);
  if (!match) throw new Error("Around window must use ms, s, m, or h");
  const factor = { ms: 0.001, s: 1, m: 60, h: 3_600 }[match[2]];
  const seconds = Number(match[1]) * factor;
  assertDuration(seconds);
  return seconds;
}

/** @param {number} seconds */
function assertDuration(seconds) {
  if (!Number.isFinite(seconds)) throw new Error("Around window must be between 0 and 3600 seconds");
  if (seconds < 0) throw new Error("Around window must be between 0 and 3600 seconds");
  if (seconds > 3_600) throw new Error("Around window must be between 0 and 3600 seconds");
}

/** @param {unknown} value */
function identity(value) {
  return value;
}

/**
 * @param {string} value
 * @param {string} label
 */
function parseCursor(value, label) {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be a non-negative integer`);
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new Error(`${label} is out of bounds`);
  return cursor;
}

/**
 * Testable CLI entry point. The production root script can call this module
 * without inheriting process-global output or credentials.
 *
 * @param {string[]} [argv]
 * @param {{ stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream }} [io]
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const { stdout, stderr } = streamsFor(io);
  const parsed = parseArguments(argv, stderr);
  if (!parsed) return 2;
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  return inspectAndWrite(parsed, stdout, stderr);
}

/** @param {{ stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream }} io */
function streamsFor(io) {
  return { stdout: io.stdout ?? process.stdout, stderr: io.stderr ?? process.stderr };
}

/** @param {string[]} argv @param {NodeJS.WritableStream} stderr */
function parseArguments(argv, stderr) {
  try {
    return parseCliArguments(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : USAGE}\n`);
    return undefined;
  }
}

/**
 * @param {{ reference: string | undefined; query: Record<string, any> }} parsed
 * @param {NodeJS.WritableStream} stdout
 * @param {NodeJS.WritableStream} stderr
 */
async function inspectAndWrite(parsed, stdout, stderr) {
  try {
    const result = await inspectDiagnostic(parsed.reference, parsed.query);
    stdout.write(renderDiagnosticResult(result, outputFormat(parsed.query)));
    return 0;
  } catch (error) {
    const inspectError = asDiagnosticInspectError(error);
    stderr.write(`trace:inspect ${inspectError.code}: ${inspectError.message}\n`);
    return inspectError.exitCode;
  }
}

/** @param {Record<string, any>} query */
function outputFormat(query) {
  const agentQueries = new Set(["brief", "copy-all"]);
  return query.format ?? (agentQueries.has(query.query) ? "agent" : "text");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await main();
  process.exitCode = exitCode;
}

export { USAGE, parseDuration, parseCursor };
