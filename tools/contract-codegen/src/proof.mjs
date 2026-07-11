// @ts-check

import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { canonicalContractJson } from "./contract-ir.mjs";
import { fixturePaths, generatedPaths } from "./fixture-paths.mjs";
import { canonicalJsonFixture } from "./json-frontend.mjs";
import { compileTypeSpecFixture, loadTypeSpecContract } from "./typespec-frontend.mjs";

const deterministicRuns = 20;
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceDirectory, "../../..");
const jsonAdapterFiles = ["json-frontend.mjs", "json-parser.mjs"];
const typeSpecAdapterFiles = ["typespec-frontend.mjs", "typespec-lowering.mjs", "typespec-proof/decorators.mjs", "typespec-proof/tsp-index.mjs", "typespec-proof/main.tsp"];

/** @typedef {Record<string, any>} ContractObject */
/** @typedef {{adapterLoc: number; sourceFiles: number; requiredPackages: number; dependencyBytes: number}} FrontendMeasurement */

/** @param {string} output */
function sha256(output) {
  return createHash("sha256").update(output).digest("hex");
}

/** @param {() => Promise<string>} produce */
async function measureFrontend(produce) {
  const output = await produce();
  let deterministic = true;
  for (let run = 1; run < deterministicRuns; run += 1) {
    deterministic &&= output === (await produce());
  }
  return { bytes: Buffer.byteLength(output), deterministic, output };
}

/** @param {() => Promise<unknown>} action @param {RegExp} expected */
async function assertDiagnostic(action, expected) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (expected.test(message)) {
      return true;
    }
    throw new Error(`Expected diagnostic ${expected}, received:\n${message}`);
  }
  throw new Error(`Expected diagnostic ${expected}, but the invalid fixture was accepted`);
}

/** @param {boolean} condition @param {string} message */
function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** @template T @param {T | undefined} value @param {string} message @returns {T} */
function required(value, message) {
  requireCondition(value !== undefined, message);
  return /** @type {T} */ (value);
}

/** @param {ContractObject} contract */
function assertFixtureCoverage(contract) {
  const declarations = /** @type {ContractObject[]} */ (contract.declarations);
  const byId = new Map(declarations.map((declaration) => [String(declaration.id), declaration]));
  const ids = ["Tenant", "User", "Room", "TenantId", "UserId", "RoomId", "ParticipantId", "UserRole", "ProviderConfig", "OpaqueJson", "SyncHelloFrame", "SyncWelcome", "SyncCommand", "SyncAck", "SyncEvent", "SyncProtocolError"];
  ids.forEach((id) => requireCondition(byId.has(`chalk.${id}`), `Fixture coverage is missing chalk.${id}`));
  const tenant = /** @type {ContractObject} */ (byId.get("chalk.Tenant"));
  const user = /** @type {ContractObject} */ (byId.get("chalk.User"));
  const room = /** @type {ContractObject} */ (byId.get("chalk.Room"));
  const provider = /** @type {ContractObject} */ (byId.get("chalk.ProviderConfig"));
  const role = /** @type {ContractObject} */ (byId.get("chalk.UserRole"));
  const roomFields = /** @type {ContractObject[]} */ (room.fields);
  const userFields = /** @type {ContractObject[]} */ (user.fields);
  const githubFields = /** @type {ContractObject[]} */ (/** @type {ContractObject} */ (byId.get("chalk.GitHubProviderConfig")).fields);
  const description = roomFields.find((field) => field.name === "description");
  requireCondition(provider.discriminator === "provider" && provider.kind === "union", "Provider configuration is not discriminated");
  requireCondition(Array.isArray(role.values) && role.values.length === 3, "Enum coverage is incomplete");
  requireCondition(JSON.stringify(tenant).includes('"kind":"record"') && JSON.stringify(tenant).includes('"items"'), "Tenant lacks record, array, or recursive references");
  requireCondition(JSON.stringify(user).includes("chalk.User") && JSON.stringify(room).includes("chalk.OpaqueJson"), "User or Room reference coverage is incomplete");
  requireCondition(description?.optional === true && description.nullable === true, "Optional nullable fields are not preserved");
  requireCondition(
    userFields.some((field) => field.name === "email" && field.constraints?.format === "email"),
    "String format coverage is missing",
  );
  requireCondition(
    githubFields.some((field) => field.name === "installationId" && field.constraints?.minimum === 1 && field.constraints?.maximum === 9007199254740991),
    "Numeric range coverage is missing",
  );
  ["TenantId", "UserId", "RoomId", "ParticipantId"].forEach((id) => requireCondition(byId.get(`chalk.${id}`)?.kind === "scalar", `Brand ${id} is missing`));
  const http = /** @type {ContractObject} */ (contract.http);
  const group = required(/** @type {ContractObject[]} */ (http.groups)[0], "HTTP fixture group is missing");
  const operations = /** @type {ContractObject[]} */ (group.operations);
  requireCondition(group.auth?.kind === "bearer" && group.rateLimit?.requests === 60 && group.bodyLimitBytes === 65536, "HTTP group metadata is incomplete");
  requireCondition(operations.length === 3, "Fixture must include three HTTP operations");
  const create = operations.find((operation) => operation.id === "rooms.create");
  const get = operations.find((operation) => operation.id === "tenants.get");
  const list = operations.find((operation) => operation.id === "rooms.list");
  const createOperation = required(create, "Create operation is missing");
  const getOperation = required(get, "Get operation is missing");
  const listOperation = required(list, "List operation is missing");
  const createSuccesses = /** @type {ContractObject[]} */ (createOperation.successes);
  const createErrors = /** @type {ContractObject[]} */ (createOperation.errors);
  const getSuccesses = /** @type {ContractObject[]} */ (getOperation.successes);
  const getErrors = /** @type {ContractObject[]} */ (getOperation.errors);
  const queryParameters = /** @type {ContractObject[]} */ (listOperation.queryParameters);
  const requestHeaders = /** @type {ContractObject[]} */ (createOperation.headers);
  const responseHeaders = /** @type {ContractObject[]} */ (createSuccesses[0]?.headers);
  requireCondition(createSuccesses[0]?.status === 201 && createErrors.map((response) => response.status).join(",") === "400,401,429", "Create response statuses are not preserved");
  requireCondition(getSuccesses[0]?.status === 200 && getErrors.map((response) => response.status).join(",") === "401,404", "Get response statuses are not preserved");
  requireCondition(queryParameters.some((parameter) => parameter.name === "pageSize" && parameter.optional === false) && queryParameters.some((parameter) => parameter.name === "cursor" && parameter.optional === true), "Query requiredness is not preserved");
  requireCondition(requestHeaders.some((header) => header.name === "idempotency-key") && responseHeaders.some((header) => header.name === "x-request-id"), "HTTP header metadata is incomplete");
  const sync = /** @type {ContractObject} */ (contract.sync);
  requireCondition(sync.protocolVersion === "1" && sync.revision?.stream === "control" && sync.revision?.cursorPath === "streams.control.cursor" && sync.revision?.resume === "exclusive", "Sync revision and cursor metadata is incomplete");
  requireCondition(sync.hello?.request?.ref === "chalk.SyncHelloFrame" && sync.hello?.ack?.ref === "chalk.SyncWelcome", "Sync hello or welcome metadata is incomplete");
  const commands = /** @type {ContractObject[]} */ (sync.commands);
  const events = /** @type {ContractObject[]} */ (sync.events);
  const frames = /** @type {ContractObject[]} */ (sync.frames);
  const closeCodes = /** @type {ContractObject[]} */ (sync.closeCodes);
  requireCondition(commands.map((command) => command.id).join(",") === "lower_hand,raise_hand", "Sync commands are incomplete");
  requireCondition(events.map((event) => event.id).join(",") === "hand_lowered,hand_raised,participant_joined,participant_left", "Sync events are incomplete");
  requireCondition(JSON.stringify(byId.get("chalk.SyncAck")).includes("committed") && JSON.stringify(byId.get("chalk.SyncAck")).includes("duplicate") && JSON.stringify(byId.get("chalk.SyncAck")).includes("rejected"), "Sync acknowledgement outcomes are incomplete");
  requireCondition(JSON.stringify(byId.get("chalk.SyncWelcome")).includes("snapshot") && JSON.stringify(byId.get("chalk.SyncWelcome")).includes("replay"), "Sync welcome modes are incomplete");
  requireCondition(frames.map((frame) => frame.kind).join(",") === "ack,command,error,event,hello,ping,pong,welcome", "Sync frames are incomplete");
  requireCondition(closeCodes.map((closeCode) => closeCode.code).join(",") === "1002,1012,1011,1008,1003" && sync.connection?.helloTimeoutMs === 10000 && sync.connection?.reconnectOnCloseCodes?.[0] === 1012, "Sync close and connection behavior is incomplete");
}

/** @param {unknown} value @param {string} [path] */
function assertNoUnknown(value, path = "contract") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnknown(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  requireCondition(record.kind !== "unknown", `${path}: unintended unknown type`);
  Object.entries(record).forEach(([key, child]) => assertNoUnknown(child, `${path}.${key}`));
}

async function assertExactPins() {
  const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "tools/contract-codegen/package.json"), "utf8"));
  const dependencies = /** @type {Record<string, string>} */ (packageJson.devDependencies);
  const names = ["@typespec/compiler", "@typespec/http"];
  const invalid = names.filter((name) => dependencies[name] !== "1.13.0");
  requireCondition(invalid.length === 0, `TypeSpec dependencies require exact 1.13.0 pins: ${invalid.join(", ")}`);
  return names;
}

/** @param {string} path */
async function nonCommentLines(path) {
  const source = await readFile(resolve(sourceDirectory, path), "utf8");
  return source.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("//");
  }).length;
}

/** @param {string[]} files */
async function adapterLoc(files) {
  return (await Promise.all(files.map((file) => nonCommentLines(file)))).reduce((sum, lines) => sum + lines, 0);
}

/** @param {string} path @returns {Promise<number>} */
async function packageBytes(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    return 0;
  }
  if (!info.isDirectory()) {
    return info.size;
  }
  const entries = await readdir(path, { withFileTypes: true });
  const sizes = /** @type {number[]} */ (await Promise.all(entries.filter((entry) => entry.name !== "node_modules").map((entry) => packageBytes(resolve(path, entry.name)))));
  return sizes.reduce((sum, size) => sum + size, 0);
}

/** @param {string[]} names */
async function requiredPackageFootprint(names) {
  const directories = new Set();
  /** @param {string} importer @param {string} name */
  const packageDirectory = async (importer, name) => {
    const entry = createRequire(resolve(importer, "package.json")).resolve(name);
    let directory = dirname(entry);
    while (directory !== dirname(directory)) {
      const packageJson = await readFile(resolve(directory, "package.json"), "utf8")
        .then(JSON.parse)
        .catch(() => undefined);
      if (packageJson?.name === name) {
        return realpath(directory);
      }
      directory = dirname(directory);
    }
    throw new Error(`Could not resolve package directory for ${name}`);
  };
  /** @param {string} importer @param {string} name */
  const visit = async (importer, name) => {
    const directory = await packageDirectory(importer, name);
    if (directories.has(directory)) {
      return;
    }
    directories.add(directory);
    const packageJson = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
    const dependencies = Object.keys(packageJson.dependencies ?? {});
    const optionalDependencies = Object.keys(packageJson.optionalDependencies ?? {});
    await Promise.all(dependencies.map((dependency) => visit(directory, dependency)));
    await Promise.all(optionalDependencies.map((dependency) => visit(directory, dependency).catch((error) => (error?.code === "MODULE_NOT_FOUND" ? undefined : Promise.reject(error)))));
  };
  await Promise.all(names.map((name) => visit(resolve(repositoryRoot, "tools/contract-codegen"), name)));
  return { bytes: (await Promise.all([...directories].map((directory) => packageBytes(directory)))).reduce((sum, size) => sum + size, 0), packages: directories.size };
}

/** @param {number} bytes */
function mebibytes(bytes) {
  return bytes / (1024 * 1024);
}

/** @param {string} contents */
async function writeGeneratedIr(contents) {
  await mkdir(dirname(generatedPaths.ir), { recursive: true });
  await writeFile(generatedPaths.ir, contents);
}

/** @param {string} contents */
async function writeReport(contents) {
  await mkdir(dirname(generatedPaths.report), { recursive: true });
  await writeFile(generatedPaths.report, contents);
}

/** @param {{ gates: { name: string; passed: boolean }[]; hash: string; json: FrontendMeasurement; sharedIrLoc: number; typeSpec: FrontendMeasurement }} result */
function renderReport(result) {
  const gates = result.gates.map((gate) => `| ${gate.name} | ${gate.passed ? "PASS" : "FAIL"} |`).join("\n");
  /** @param {string} name @param {FrontendMeasurement} measurement */
  const row = (name, measurement) => `| ${name} | ${measurement.adapterLoc} | ${measurement.sourceFiles} | ${measurement.requiredPackages} | ${mebibytes(measurement.dependencyBytes).toFixed(2)} |`;
  return `# Chalk frontend contract proof

Both frontends lower the same representative Chalk fixture to byte-identical canonical ContractIR. This establishes fixture parity. It does not establish semantic equivalence for every valid or invalid contract.

## Hard gates

| Gate | Result |
| --- | --- |
${gates}

## Observed measurements

| Frontend | Adapter source lines | Adapter files | Required packages in transitive closure | Required package footprint (MiB) |
| --- | ---: | ---: | ---: | ---: |
${row("Chalk-native JSON", result.json)}
${row("TypeSpec", result.typeSpec)}

Source-line counts exclude blank lines and lines beginning with \`//\`; block-comment lines remain included. The shared ContractIR validator is ${result.sharedIrLoc} lines by that measure and is excluded from both adapter figures. The TypeSpec footprint is the real on-disk size of only @typespec/compiler, @typespec/http, and their declared runtime dependency closure. Runtime timing is excluded because warm in-process measurements were too environment-sensitive to support a decision.

## Decision status

Inconclusive. The proof establishes deterministic fixture parity and dependency cost. Frontend selection remains blocked on cross-field semantic validation, clean source-located semantic diagnostics, and an explicit project rubric for the qualitative criteria.

Canonical SHA-256: \`${result.hash}\`
`;
}

export async function canonicalFrontendOutputs() {
  const jsonOutput = await canonicalJsonFixture(fixturePaths.json);
  const typeSpecOutput = canonicalContractJson(await loadTypeSpecContract(fixturePaths.typeSpec));
  return { jsonOutput, typeSpecOutput };
}

export async function generate() {
  const outputs = await canonicalFrontendOutputs();
  requireCondition(outputs.jsonOutput === outputs.typeSpecOutput, "Chalk JSON and TypeSpec frontends produced different canonical ContractIR bytes");
  await writeGeneratedIr(outputs.jsonOutput);
  return { bytes: Buffer.byteLength(outputs.jsonOutput), path: generatedPaths.ir, sha256: sha256(outputs.jsonOutput) };
}

export async function check() {
  const generated = await readFile(generatedPaths.ir, "utf8").catch(() => undefined);
  if (!generated) {
    throw new Error(`Missing generated ContractIR: run generate to create ${generatedPaths.ir}`);
  }
  const outputs = await canonicalFrontendOutputs();
  requireCondition(outputs.jsonOutput === outputs.typeSpecOutput, "Chalk JSON and TypeSpec frontends produced different canonical ContractIR bytes");
  requireCondition(generated === outputs.jsonOutput, `Generated ContractIR is stale: ${generatedPaths.ir}`);
  return { bytes: Buffer.byteLength(generated), path: generatedPaths.ir, sha256: sha256(generated) };
}

export async function proof() {
  const outputs = await canonicalFrontendOutputs();
  const canonical = JSON.parse(outputs.jsonOutput);
  const pins = await assertExactPins();
  const json = { ...(await measureFrontend(() => canonicalJsonFixture(fixturePaths.json))), adapterLoc: await adapterLoc(jsonAdapterFiles), dependencyBytes: 0, requiredPackages: 0, sourceFiles: jsonAdapterFiles.length };
  const footprint = await requiredPackageFootprint(pins);
  const typeSpec = {
    ...(await measureFrontend(async () => canonicalContractJson(await loadTypeSpecContract(fixturePaths.typeSpec)))),
    adapterLoc: await adapterLoc(typeSpecAdapterFiles),
    dependencyBytes: footprint.bytes,
    requiredPackages: footprint.packages,
    sourceFiles: typeSpecAdapterFiles.length,
  };
  const gates = [
    {
      name: "Representative fixture assertions",
      passed: (() => {
        assertFixtureCoverage(canonical);
        return true;
      })(),
    },
    {
      name: "No unintended unknown types",
      passed: (() => {
        assertNoUnknown(canonical);
        return true;
      })(),
    },
    {
      name: "Representative parser, compiler, and lowering diagnostics",
      passed:
        (await assertDiagnostic(() => canonicalJsonFixture(fixturePaths.invalidTrailingComma), /trailing comma/u)) &&
        (await assertDiagnostic(() => canonicalJsonFixture(fixturePaths.invalidDuplicateKey), /duplicate key/u)) &&
        (await assertDiagnostic(() => compileTypeSpecFixture(fixturePaths.invalidTypeSpecReference), /missing-reference\.tsp:\d+:\d+/u)) &&
        (await assertDiagnostic(() => loadTypeSpecContract(fixturePaths.invalidTypeSpecLowering), /missing-discriminator\.tsp:\d+:\d+/u)),
    },
    { name: "Exact required TypeSpec dependency pins", passed: pins.length === 2 },
    { name: "Byte-identical output across 20 full frontend runs", passed: json.deterministic && typeSpec.deterministic && json.output === typeSpec.output },
  ];
  await writeGeneratedIr(outputs.jsonOutput);
  await writeReport(renderReport({ gates, hash: sha256(outputs.jsonOutput), json, sharedIrLoc: await nonCommentLines("contract-ir.mjs"), typeSpec }));
  requireCondition(
    gates.every((gate) => gate.passed),
    "Frontend proof hard gates failed",
  );
  return { bytes: Buffer.byteLength(outputs.jsonOutput), irPath: generatedPaths.ir, recommendation: "Inconclusive", reportPath: generatedPaths.report };
}
