#!/usr/bin/env node
// @ts-check

import { createFeedbackClient } from "./feedback-client.mjs";
import { writeFeedbackPull } from "./feedback-download.mjs";
import { openFeedbackReport } from "./feedback-open.mjs";
import { renderFeedbackList, renderFeedbackOpen, renderFeedbackPull, renderFeedbackShow, safeFeedbackJSON } from "./feedback-render.mjs";
import { DiagnosticInspectError, asDiagnosticInspectError } from "./errors.mjs";
import { optionValue, splitFlag } from "./cli.mjs";

export const FEEDBACK_USAGE = "Usage: pnpm feedback <list|show|pull|open> [<id>] [options]";
export const FEEDBACK_HELP = `${FEEDBACK_USAGE}

Commands:
  list                 List reports. Supports category, source, Tenant, time, and cursor filters.
  show <id>            Print one report without downloading evidence.
  pull <id>            Download verified evidence into a new or empty private directory.
  open <id>            Open the strongest safe Journey or trace correlation.

Options:
  --category <value>   list: bug, feature_request, or other
  --source <value>     list: filter by Feedback source
  --tenant-id <id>     list: filter by authorized Tenant
  --from <time>        list: inclusive RFC 3339 start time
  --to <time>          list: exclusive RFC 3339 end time
  --cursor <value>     list: continue from a previous page
  --page-size <1-100>  list: number of reports
  -o, --output <path>  pull: destination; non-empty directories are refused
  --no-launch          open: print the safe destination without launching it
  -f, --format <value> text or json
  -h, --help           Show this help

Operator configuration:
  CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN or CHALK_DIAGNOSTICS_OPERATOR_CREDENTIAL
  CHALK_DIAGNOSTICS_CREDENTIAL_FILE, CHALK_DIAGNOSTICS_URL, CHALK_DIAGNOSTICS_ENV
  CHALK_FEEDBACK_OBSERVABILITY_URL and CHALK_FEEDBACK_OBSERVABILITY_HOSTS for open`;
const COMMANDS = new Set(["list", "show", "pull", "open"]);
const VALUE_OPTIONS = new Set(["--category", "--source", "--tenant", "--tenant-id", "--from", "--from-time", "--since", "--to", "--to-time", "--until", "--cursor", "--page-size", "--limit", "--output", "-o", "--format", "-f"]);
const OPTION_KEYS = Object.freeze({
  "--category": "category",
  "--source": "source",
  "--tenant": "tenant_id",
  "--tenant-id": "tenant_id",
  "--from": "from",
  "--from-time": "from",
  "--since": "from",
  "--to": "to",
  "--to-time": "to",
  "--until": "to",
  "--cursor": "cursor",
  "--page-size": "page_size",
  "--limit": "page_size",
  "--output": "output",
  "-o": "output",
  "--format": "format",
  "-f": "format",
});
const OPTION_SETTERS = Object.freeze({
  category: (options, value) => {
    options.category = value;
  },
  source: (options, value) => {
    options.source = value;
  },
  tenant_id: (options, value) => {
    options.tenant_id = value;
  },
  from: (options, value) => {
    options.from = value;
  },
  to: (options, value) => {
    options.to = value;
  },
  cursor: (options, value) => {
    options.cursor = value;
  },
  output: (options, value) => {
    options.output = value;
  },
  format: (options, value) => {
    options.format = formatValue(value);
  },
  page_size: (options, value) => {
    options.page_size = parsePageSize(value);
  },
});

/** @typedef {"list" | "show" | "pull" | "open"} FeedbackCommand */
/** @typedef {"text" | "json"} FeedbackFormat */
/** @typedef {{ category?: string; source?: string; tenant_id?: string; from?: string; to?: string; cursor?: string; page_size?: number; output?: string; format: FeedbackFormat; launch?: boolean }} FeedbackCliOptions */
/** @typedef {{ help: true } | { help: false; command: FeedbackCommand; id?: string; options: FeedbackCliOptions }} FeedbackCliParseResult */
/** @typedef {{ stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream }} FeedbackIO */
/** @typedef {import("./feedback-client.mjs").FeedbackClient} FeedbackClient */
/** @typedef {import("./feedback-download.mjs").FeedbackPullResult} FeedbackPullResult */
/** @typedef {import("./feedback-open.mjs").FeedbackOpenResult} FeedbackOpenResult */
/** @typedef {import("./feedback-parsers.mjs").FeedbackListResponse} FeedbackListResponse */
/** @typedef {import("./feedback-parsers.mjs").FeedbackReport} FeedbackReport */
/** @typedef {FeedbackListResponse | FeedbackReport | FeedbackPullResult | FeedbackOpenResult} FeedbackCommandResult */
/** @typedef {{ client?: FeedbackClient; createClient?: typeof createFeedbackClient; open?: typeof openFeedbackReport; pull?: typeof writeFeedbackPull }} FeedbackDependencies */
/** @typedef {{ help: boolean; positional: string[]; options: FeedbackCliOptions }} FeedbackScanResult */
/** @typedef {{ help: boolean; nextIndex: number }} FeedbackOptionResult */

/**
 * @param {string[]} argv
 * @returns {FeedbackCliParseResult}
 */
export function parseFeedbackCliArguments(argv) {
  if (isHelpRequest(argv)) return { help: true };
  const command = argv[0];
  if (!isFeedbackCommand(command)) throw new Error(FEEDBACK_USAGE);
  const scanned = scanFeedbackArguments(argv.slice(1));
  if (scanned.help) return { help: true };
  validateCommand(command, scanned.positional, scanned.options);
  return { help: false, command, id: scanned.positional[0], options: scanned.options };
}

/** @param {string[]} argv */
function isHelpRequest(argv) {
  return argv.length === 0 || argv[0] === "--help" || argv[0] === "-h";
}

/** @returns {FeedbackCliOptions} */
function defaultOptions() {
  return { format: "text" };
}

/** @param {string | undefined} value @returns {value is FeedbackCommand} */
function isFeedbackCommand(value) {
  return typeof value === "string" && COMMANDS.has(value);
}

/** @param {string[]} argv @returns {FeedbackScanResult} */
function scanFeedbackArguments(argv) {
  const positional = [];
  const options = defaultOptions();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    const result = consumeFeedbackOption(argument, argv, index, options);
    index = result.nextIndex;
    if (result.help) return { help: true, positional, options };
  }
  return { help: false, positional, options };
}

/** @param {string} argument @param {string[]} argv @param {number} index @param {FeedbackCliOptions} options @returns {FeedbackOptionResult} */
function consumeFeedbackOption(argument, argv, index, options) {
  const [flag, inlineValue] = splitFlag(argument);
  if (isHelpFlag(flag)) return { help: true, nextIndex: index };
  if (isLaunchFlag(flag)) return consumeLaunchOption(flag, inlineValue, index, options);
  return consumeValueOption(flag, inlineValue, argv, index, options);
}

/** @param {string} flag */
function isHelpFlag(flag) {
  return flag === "--help" || flag === "-h";
}

/** @param {string} flag */
function isLaunchFlag(flag) {
  return flag === "--no-launch" || flag === "--print";
}

/** @param {string} flag @param {string | undefined} inlineValue @param {number} index @param {FeedbackCliOptions} options */
function consumeLaunchOption(flag, inlineValue, index, options) {
  if (inlineValue !== undefined) throw new Error(`${flag} does not take a value`);
  options.launch = false;
  return { help: false, nextIndex: index };
}

/** @param {string} flag @param {string | undefined} inlineValue @param {string[]} argv @param {number} index @param {FeedbackCliOptions} options */
function consumeValueOption(flag, inlineValue, argv, index, options) {
  if (!VALUE_OPTIONS.has(flag)) throw new Error(`Unknown option ${flag}`);
  const value = optionValue(flag, inlineValue, argv, index);
  setOption(options, flag, value.value);
  return { help: false, nextIndex: value.nextIndex };
}

/** @param {FeedbackCliOptions} options @param {string} flag @param {string} value */
function setOption(options, flag, value) {
  const key = OPTION_KEYS[flag];
  const setter = key ? OPTION_SETTERS[key] : undefined;
  if (!setter) throw new Error(`Unknown option ${flag}`);
  setter(options, value);
}

/** @param {string} value @returns {number} */
function parsePageSize(value) {
  return validatePageSize(Number(value), value);
}

/** @param {number} pageSize @param {string} value */
function validatePageSize(pageSize, value) {
  validatePageSizeText(value);
  validatePageSizeRange(pageSize);
  return pageSize;
}

/** @param {string} value */
function validatePageSizeText(value) {
  if (!/^\d+$/u.test(value)) throw new Error("Feedback page size must be a positive integer");
}

/** @param {number} pageSize */
function validatePageSizeRange(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Feedback page size must be between 1 and 100");
}

/** @param {string} value @returns {FeedbackFormat} */
function formatValue(value) {
  if (value === "text" || value === "json") return value;
  throw new Error("Feedback format must be text or json");
}

/** @param {FeedbackCommand} command @param {string[]} positional @param {FeedbackCliOptions} options */
function validateCommand(command, positional, options) {
  validatePositional(command, positional);
  validateOutput(command, options.output);
  validateLaunch(command, options.launch);
  validateListOnlyOptions(command, options);
}

/** @param {FeedbackCommand} command @param {string[]} positional */
function validatePositional(command, positional) {
  const expected = command === "list" ? 0 : 1;
  if (positional.length !== expected) throw new Error(FEEDBACK_USAGE);
}

/** @param {FeedbackCommand} command @param {string | undefined} output */
function validateOutput(command, output) {
  validateOutputValue(output, command);
  if (command !== "pull" && output !== undefined) throw new Error("--output is only valid for feedback pull");
}

/** @param {string | undefined} output @param {FeedbackCommand} command */
function validateOutputValue(output, command) {
  validateOutputEmpty(command, output);
  validateOutputCharacters(output);
}

/** @param {FeedbackCommand} command @param {string | undefined} output */
function validateOutputEmpty(command, output) {
  if (command === "pull" && output === "") throw new Error("Feedback output path must not be empty");
}

/** @param {string | undefined} output */
function validateOutputCharacters(output) {
  if (output !== undefined && !isSafeOutputPath(output)) throw new Error("Feedback output path is invalid");
}

/** @param {string} output */
function isSafeOutputPath(output) {
  return output.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(output);
}

/** @param {FeedbackCommand} command @param {boolean | undefined} launch */
function validateLaunch(command, launch) {
  if (command !== "open" && launch !== undefined) throw new Error("--no-launch is only valid for feedback open");
}

/** @param {FeedbackCommand} command @param {FeedbackCliOptions} options */
function validateListOnlyOptions(command, options) {
  if (command === "list") return;
  const fields = [
    ["category", options.category],
    ["source", options.source],
    ["tenant_id", options.tenant_id],
    ["from", options.from],
    ["to", options.to],
    ["cursor", options.cursor],
    ["page_size", options.page_size],
  ];
  const invalid = fields.find(([, value]) => value !== undefined);
  if (invalid) throw new Error(`${invalid[0]} is only valid for feedback list`);
}

/**
 * @param {string[]} [argv]
 * @param {FeedbackIO} [io]
 * @param {FeedbackDependencies} [dependencies]
 */
export async function main(argv = process.argv.slice(2), io = {}, dependencies = {}) {
  const stdout = outputStream(io.stdout, process.stdout);
  const stderr = outputStream(io.stderr, process.stderr);
  const parsed = parseMainArguments(argv, stderr);
  if (!parsed) return 2;
  if (parsed.help) {
    stdout.write(`${FEEDBACK_HELP}\n`);
    return 0;
  }
  return executeMainCommand(parsed, stdout, stderr, dependencies);
}

/** @param {NodeJS.WritableStream | undefined} stream @param {NodeJS.WritableStream} fallback */
function outputStream(stream, fallback) {
  return stream ?? fallback;
}

/** @param {string[]} argv @param {NodeJS.WritableStream} stderr @returns {FeedbackCliParseResult | undefined} */
function parseMainArguments(argv, stderr) {
  try {
    return parseFeedbackCliArguments(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : FEEDBACK_USAGE}\n`);
    return undefined;
  }
}

/** @param {Exclude<FeedbackCliParseResult, { help: true }>} parsed @param {NodeJS.WritableStream} stdout @param {NodeJS.WritableStream} stderr @param {FeedbackDependencies} dependencies */
async function executeMainCommand(parsed, stdout, stderr, dependencies) {
  try {
    const client = dependencies.client ?? (await (dependencies.createClient ?? createFeedbackClient)());
    const result = await runCommand(parsed, client, dependencies);
    stdout.write(renderResult(parsed, result));
    return 0;
  } catch (error) {
    const feedbackError = asDiagnosticInspectError(error);
    stderr.write(`feedback ${feedbackError.code}: ${feedbackError.message}\n`);
    return feedbackError.exitCode;
  }
}

/** @param {Exclude<FeedbackCliParseResult, { help: true }>} parsed @param {FeedbackClient} client @param {FeedbackDependencies} dependencies @returns {Promise<FeedbackCommandResult>} */
async function runCommand(parsed, client, dependencies) {
  if (parsed.command === "list") return runListCommand(parsed, client);
  const id = requiredId(parsed);
  const report = await client.show(id);
  if (parsed.command === "show") return report;
  if (parsed.command === "open") return runOpenCommand(parsed, report, client, dependencies);
  return runPullCommand(parsed, report, client, dependencies);
}

/** @param {Exclude<FeedbackCliParseResult, { help: true }>} parsed @param {FeedbackClient} client */
function runListCommand(parsed, client) {
  const { format: _format, launch: _launch, ...filters } = parsed.options;
  return client.list(filters);
}

/** @param {Exclude<FeedbackCliParseResult, { help: true }>} parsed @param {FeedbackReport} report @param {FeedbackClient} client @param {FeedbackDependencies} dependencies */
function runOpenCommand(parsed, report, client, dependencies) {
  return (dependencies.open ?? openFeedbackReport)(report, { config: client.config, launch: parsed.options.launch !== false });
}

/** @param {Exclude<FeedbackCliParseResult, { help: true }>} parsed @param {FeedbackReport} report @param {FeedbackClient} client @param {FeedbackDependencies} dependencies */
async function runPullCommand(parsed, report, client, dependencies) {
  const evidence = await client.evidence(report.id);
  validateReportEvidence(report, evidence);
  const screenshot = await optionalScreenshot(report, client);
  return (dependencies.pull ?? writeFeedbackPull)({ report, evidence, screenshot, output: parsed.options.output });
}

/** @param {FeedbackReport} report @param {{ size: number; sha256: string }} evidence */
function validateReportEvidence(report, evidence) {
  if (evidence.size !== report.evidence.size || evidence.sha256 !== report.evidence.sha256) throw new DiagnosticInspectError("checksum_mismatch", "Feedback evidence did not match the report checksum");
}

/** @param {FeedbackReport} report @param {FeedbackClient} client */
async function optionalScreenshot(report, client) {
  if (!report.evidence.screenshot) return undefined;
  try {
    return await client.screenshot(report.id);
  } catch (error) {
    const feedbackError = asDiagnosticInspectError(error);
    if (feedbackError.code !== "not_found") throw feedbackError;
    return undefined;
  }
}

/** @param {Exclude<FeedbackCliParseResult, { help: true }>} parsed @param {FeedbackCommandResult} result @returns {string} */
function renderResult(parsed, result) {
  if (parsed.command === "list") return renderFeedbackList(result, parsed.options.format);
  if (parsed.command === "show") return renderFeedbackShow(result, parsed.options.format);
  if (parsed.command === "pull") return renderPullResult(result, parsed.options.format);
  return renderOpenResult(result, parsed.options.format);
}

/** @param {FeedbackPullResult} result @param {FeedbackFormat} format */
function renderPullResult(result, format) {
  return format === "json" ? safeFeedbackJSON(result) : renderFeedbackPull(result);
}

/** @param {FeedbackOpenResult} result @param {FeedbackFormat} format */
function renderOpenResult(result, format) {
  return format === "json" ? safeFeedbackJSON(result) : renderFeedbackOpen(result);
}

/** @param {Exclude<FeedbackCliParseResult, { help: true }>} parsed @returns {string} */
function requiredId(parsed) {
  if (!parsed.id) throw new Error(FEEDBACK_USAGE);
  return parsed.id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
