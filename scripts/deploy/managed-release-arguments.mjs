const DEFAULT_TIMEOUT_SECONDS = 900;

const environmentPattern = /^[a-z][a-z0-9-]{0,31}$/;
const regionPattern = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/;
const instancePattern = /^i-[0-9a-f]{8,17}$/;
const documentNamePattern = /^[A-Za-z0-9_.-]{3,128}$/;
const documentVersionPattern = /^[1-9][0-9]*$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+=-]{0,127}$/;
const secretIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const parameterPrefixPattern = /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;

const optionProperties = {
  document: "documentPath",
  "document-name": "documentName",
  "document-version": "documentVersion",
  environment: "environment",
  "instance-id": "instanceId",
  "log-group-name": "logGroupName",
  manifest: "manifestPath",
  "parameter-prefix": "parameterPrefix",
  region: "region",
  "request-id": "requestId",
};

const requiredOptions = ["manifestPath", "environment", "region", "instanceId", "documentName", "parameterPrefix", "requestId", "logGroupName"];

const optionValidationRules = [
  [(options) => environmentPattern.test(options.environment) && ["staging", "production"].includes(options.environment), "--environment must be staging or production"],
  [(options) => regionPattern.test(options.region), "--region is invalid"],
  [(options) => instancePattern.test(options.instanceId), "--instance-id is invalid"],
  [(options) => documentNamePattern.test(options.documentName), "--document-name is invalid"],
  [(options) => !options.documentVersion || documentVersionPattern.test(options.documentVersion), "--document-version must be a pinned numeric version"],
  [(options) => parameterPrefixPattern.test(options.parameterPrefix) && !options.parameterPrefix.includes("..") && options.parameterPrefix.length <= 900, "--parameter-prefix is invalid"],
  [(options) => options.parameterPrefix === `/chalk/${options.environment}` || options.parameterPrefix.startsWith(`/chalk/${options.environment}/`), "--parameter-prefix must be scoped to --environment"],
  [(options) => requestIdPattern.test(options.requestId), "--request-id is invalid"],
  [(options) => /^\/[A-Za-z0-9_./#-]+$/.test(options.logGroupName) && options.logGroupName.length <= 512, "--log-group-name must be an absolute CloudWatch log group name"],
];

export { DEFAULT_TIMEOUT_SECONDS };

export function usage() {
  return `Usage: pnpm run release:managed:ci -- \\
  --manifest <release-manifest.json> \\
  --environment <staging|production> \\
  --region <aws-region> \\
  --instance-id <i-...> \\
  --document-name <ssm-document> \\
  (--document <command-document.json> | --document-version <number>) \\
  --parameter-prefix </chalk/environment/path> \\
  --request-id <ci-run-id> \\
  --log-group-name <cloudwatch-log-group> \\
  [--adopt-existing-release] \\
  [--exclude-secret <canonical-id>]... \\
  [--timeout-seconds <60-3600>] \\
  [--dry-run]

Missing runtime inputs fail on the host unless their exact canonical IDs are
passed with repeated --exclude-secret arguments. Wildcards are not accepted.`;
}

export function parseArguments(arguments_) {
  const options = createDefaultOptions();
  const tokens = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  let index = 0;
  while (index < tokens.length) {
    index += applyArgument(options, tokens, index);
  }
  return finishOptions(options);
}

export function normalizeExclusions(exclusions, allowedSecretIds) {
  const ids = exclusions.map(normalizeExcludedSecret);
  const allowed = new Set(allowedSecretIds);
  const unknown = ids.find((id) => !allowed.has(id));
  if (unknown) throw new Error(`unknown excluded secret ID: ${unknown}`);
  const duplicate = findDuplicate(ids);
  if (duplicate) throw new Error(`duplicate excluded secret ID: ${duplicate}`);
  return ids.sort();
}

function createDefaultOptions() {
  return {
    adoptExistingRelease: false,
    dryRun: false,
    excludedSecrets: [],
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
}

function applyArgument(options, tokens, index) {
  const argument = tokens[index];
  const flag = applyFlag(options, argument);
  if (flag) return 1;
  const parsed = parseOption(argument, tokens[index + 1]);
  if (!parsed) throw usageError(`unknown argument: ${argument}`);
  applyValueOption(options, parsed);
  return argument.includes("=") ? 1 : 2;
}

function applyFlag(options, argument) {
  const handlers = {
    "--adopt-existing-release": () => enableAdoptExistingRelease(options),
    "--dry-run": () => enableDryRun(options),
    "--help": () => {
      options.help = true;
    },
    "-h": () => {
      options.help = true;
    },
  };
  const handler = handlers[argument];
  if (!handler) return false;
  handler();
  return true;
}

function enableAdoptExistingRelease(options) {
  if (options.adoptExistingRelease) throw usageError("--adopt-existing-release was provided more than once");
  options.adoptExistingRelease = true;
}

function enableDryRun(options) {
  if (options.dryRun) throw usageError("--dry-run was provided more than once");
  options.dryRun = true;
}

function applyValueOption(options, parsed) {
  if (parsed.name === "exclude-secret") {
    options.excludedSecrets.push(parsed.value);
    return;
  }
  if (parsed.name === "timeout-seconds") {
    options.timeoutSeconds = parseTimeout(parsed.value);
    return;
  }
  assignUniqueOption(options, parsed);
}

function assignUniqueOption(options, parsed) {
  const property = optionProperties[parsed.name];
  if (!property) throw usageError(`unknown argument: --${parsed.name}`);
  if (options[property] !== undefined) throw usageError(`--${parsed.name} was provided more than once`);
  options[property] = parsed.value;
}

function finishOptions(options) {
  if (options.help) return options;
  requireOptions(options);
  if (Boolean(options.documentPath) === Boolean(options.documentVersion)) {
    throw usageError("provide exactly one of --document or --document-version");
  }
  validateOptions(options);
  return options;
}

function requireOptions(options) {
  for (const property of requiredOptions) {
    if (!options[property]) throw usageError(`--${propertyOption(property)} is required`);
  }
}

function validateOptions(options) {
  const failure = optionValidationRules.find(([isValid]) => !isValid(options));
  if (failure) throw usageError(failure[1]);
}

function parseOption(argument, nextArgument) {
  const inline = argument.match(/^--([a-z-]+)=(.*)$/);
  if (inline) return parseInlineOption(inline);
  return parseSeparateOption(argument, nextArgument);
}

function parseInlineOption(match) {
  if (!match[2]) throw usageError(`--${match[1]} requires a value`);
  return { name: match[1], value: match[2] };
}

function parseSeparateOption(argument, nextArgument) {
  const match = argument.match(/^--([a-z-]+)$/);
  if (!match) return undefined;
  requireOptionValue(argument, nextArgument);
  return { name: match[1], value: nextArgument };
}

function requireOptionValue(argument, value) {
  if (!value || value.startsWith("--")) throw usageError(`${argument} requires a value`);
}

function parseTimeout(value) {
  if (!/^[0-9]+$/.test(value)) throw usageError("--timeout-seconds must be an integer");
  const timeout = Number(value);
  if (timeout < 60 || timeout > 3_600) throw usageError("--timeout-seconds must be between 60 and 3600");
  return timeout;
}

function normalizeExcludedSecret(rawId) {
  const id = rawId.trim();
  if (rawId !== id || !secretIdPattern.test(id) || id.includes("*")) throw new Error(`invalid excluded secret ID: ${rawId}`);
  return id;
}

function findDuplicate(ids) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

function propertyOption(property) {
  return Object.entries(optionProperties).find(([, value]) => value === property)?.[0];
}

function usageError(message) {
  return new Error(`${message}\n\n${usage()}`);
}
