// @ts-check

import { chmod, lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { DiagnosticInspectError } from "./errors.mjs";

const DEFAULT_ENVIRONMENT = "localhost";
const DEFAULT_BASE_URL = "http://localhost:8080";
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const CREDENTIAL_FILE_ENV = "CHALK_DIAGNOSTICS_CREDENTIAL_FILE";
const CREDENTIAL_VALUE_ENV = "CHALK_DIAGNOSTICS_OPERATOR_CREDENTIAL";
const OPERATOR_TOKEN_ENV = "CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN";
const DEFAULT_CREDENTIAL_FILE = ".private/chalk-dev/episode-diagnostics-operator.json";
const BASE_URL_ENV = "CHALK_DIAGNOSTICS_URL";
const ENVIRONMENT_ENV = "CHALK_DIAGNOSTICS_ENV";

/**
 * @typedef {{ baseUrl: string; environment: "localhost"|"development"|"staging"|"production"; credential?: string; fetchImpl: typeof fetch }} DiagnosticOperatorConfig
 */

/**
 * Resolve operator settings without printing or returning a credential in any
 * renderer-facing object. Explicit options are useful for tests and local
 * fixture servers; environment/file settings are the normal CLI path.
 *
 * @param {{ baseUrl?: string; environment?: string; credential?: string; credentialFile?: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<DiagnosticOperatorConfig>}
 */
export async function resolveOperatorConfig(options = {}) {
  const env = processEnvironment(options);
  const fileCredential = await resolveFileCredential(options, env);
  const environment = resolveEnvironment(options, env, fileCredential);
  assertEnvironment(environment);
  const parsedBase = parseBaseUrl(resolveBaseUrl(options, env, fileCredential));
  validateServiceOrigin(parsedBase, environment);
  const credential = resolveCredential(options, env, fileCredential);
  validateOperatorCredential(environment, credential);
  const fetchImpl = resolveFetch(options);
  assertFetchImplementation(fetchImpl);
  return operatorConfig(parsedBase, environment, credential, fetchImpl);
}

/** @param {DiagnosticOperatorConfig} config */
export function validateOperatorConfig(config) {
  assertEnvironment(config.environment);
  const parsedBase = parseBaseUrl(config.baseUrl);
  validateServiceOrigin(parsedBase, config.environment);
  validateOperatorCredential(config.environment, config.credential);
  assertFetchImplementation(config.fetchImpl);
}

/** @param {{ env?: NodeJS.ProcessEnv }} options */
function processEnvironment(options) {
  return options.env ?? process.env;
}

/** @param {{ environment?: string }} options @param {NodeJS.ProcessEnv} env @param {{ environment?: string } | undefined} fileCredential */
function resolveEnvironment(options, env, fileCredential) {
  return firstDefined(options.environment, env[ENVIRONMENT_ENV], fileCredential?.environment, DEFAULT_ENVIRONMENT);
}

/** @param {{ baseUrl?: string }} options @param {NodeJS.ProcessEnv} env @param {{ apiOrigin?: string } | undefined} fileCredential */
function resolveBaseUrl(options, env, fileCredential) {
  return firstDefined(options.baseUrl, env[BASE_URL_ENV], fileCredential?.apiOrigin, DEFAULT_BASE_URL);
}

/** @param {{ credential?: string }} options @param {NodeJS.ProcessEnv} env @param {{ credential?: string } | undefined} fileCredential */
function resolveCredential(options, env, fileCredential) {
  return firstDefined(options.credential, env[OPERATOR_TOKEN_ENV], env[CREDENTIAL_VALUE_ENV], fileCredential?.credential);
}

/** @param {...unknown} values */
function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

/** @param {{ fetchImpl?: typeof fetch }} options */
function resolveFetch(options) {
  return options.fetchImpl ?? globalThis.fetch;
}

/** @param {URL} parsedBase @param {string} environment @param {string | undefined} credential @param {typeof fetch} fetchImpl */
function operatorConfig(parsedBase, environment, credential, fetchImpl) {
  return { baseUrl: parsedBase.toString().replace(/\/$/u, ""), environment: /** @type {DiagnosticOperatorConfig["environment"]} */ (environment), ...(credential ? { credential } : {}), fetchImpl };
}

/**
 * @param {{ credential?: string; credentialFile?: string; env?: NodeJS.ProcessEnv }} options
 * @param {NodeJS.ProcessEnv} env
 */
async function resolveFileCredential(options, env) {
  const configuredPath = options.credentialFile ?? env[CREDENTIAL_FILE_ENV];
  if (hasInlineCredential(options, env)) return undefined;
  return readCredentialFile(configuredPath ?? DEFAULT_CREDENTIAL_FILE, { optional: configuredPath === undefined });
}

/**
 * @param {{ credential?: string }} options
 * @param {NodeJS.ProcessEnv} env
 */
function hasInlineCredential(options, env) {
  return Boolean(options.credential ?? env[OPERATOR_TOKEN_ENV] ?? env[CREDENTIAL_VALUE_ENV]);
}

/** @param {string} environment */
function assertEnvironment(environment) {
  if (!isEnvironment(environment)) throw new DiagnosticInspectError("invalid_config", "Diagnostic environment is not enabled");
}

/** @param {string} baseUrl */
function parseBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl);
  } catch {
    throw new DiagnosticInspectError("invalid_config", "Diagnostic service URL is invalid");
  }
}

/** @param {URL} parsedBase @param {string} environment */
function validateServiceOrigin(parsedBase, environment) {
  validateProtocol(parsedBase);
  validateLocalOrigin(parsedBase, environment);
  validateHostedOrigin(parsedBase, environment);
}

/** @param {URL} parsedBase */
function validateProtocol(parsedBase) {
  if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") throw new DiagnosticInspectError("invalid_config", "Diagnostic service URL must use HTTP or HTTPS");
}

/** @param {URL} parsedBase @param {string} environment */
function validateLocalOrigin(parsedBase, environment) {
  if (environment === "localhost" && !isLoopbackHostname(parsedBase.hostname)) throw new DiagnosticInspectError("invalid_config", "Localhost diagnostics must use a loopback service URL");
}

/** @param {URL} parsedBase @param {string} environment */
function validateHostedOrigin(parsedBase, environment) {
  if (environment !== "localhost" && parsedBase.protocol !== "https:") throw new DiagnosticInspectError("invalid_config", "Hosted diagnostics must use HTTPS");
}

/** @param {string} environment @param {string | undefined} credential */
function validateOperatorCredential(environment, credential) {
  if (environment !== "production" || credential) return;
  throw new DiagnosticInspectError("invalid_config", "Production diagnostics require an operator credential");
}

/** @param {unknown} fetchImpl */
function assertFetchImplementation(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new DiagnosticInspectError("invalid_config", "Diagnostic inspection requires a fetch implementation");
}

/**
 * @param {string | undefined} explicitPath
 * @param {{ optional?: boolean }} [options]
 */
async function readCredentialFile(explicitPath, options = {}) {
  if (!explicitPath) return undefined;
  const filePath = resolveCredentialPath(explicitPath);
  const metadata = await readCredentialMetadata(filePath, options.optional);
  if (!metadata) return undefined;
  const source = await readCredentialSource(filePath);
  const parsed = parseCredentialSource(source);
  validateCredential(parsed.credential);
  await tightenCredentialFile(filePath);
  return { credential: parsed.credential, ...parsed.fileConfig };
}

/** @param {string} filePath @param {boolean | undefined} optional */
async function readCredentialMetadata(filePath, optional) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    if (optional) return undefined;
    throw new DiagnosticInspectError("invalid_config", "Diagnostic credential file could not be read");
  }
  assertRegularCredentialFile(metadata);
  assertCredentialFileMode(metadata);
  assertCredentialFileSize(metadata);
  return metadata;
}

/** @param {import("node:fs").Stats} metadata */
function assertRegularCredentialFile(metadata) {
  if (!metadata.isFile()) throw new DiagnosticInspectError("invalid_config", "Diagnostic credential file must be a regular file");
  if (metadata.isSymbolicLink()) throw new DiagnosticInspectError("invalid_config", "Diagnostic credential file must be a regular file");
}

/** @param {import("node:fs").Stats} metadata */
function assertCredentialFileMode(metadata) {
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new DiagnosticInspectError("invalid_config", "Diagnostic credential file must be private (mode 0600)");
}

/** @param {import("node:fs").Stats} metadata */
function assertCredentialFileSize(metadata) {
  if (metadata.size > MAX_CREDENTIAL_BYTES) throw new DiagnosticInspectError("invalid_config", "Diagnostic credential file is too large");
}

/** @param {string} filePath */
async function readCredentialSource(filePath) {
  try {
    const source = (await readFile(filePath, "utf8")).trim();
    if (source.length === 0) throw new DiagnosticInspectError("invalid_config", "Diagnostic credential file is empty");
    return source;
  } catch (error) {
    if (error instanceof DiagnosticInspectError) throw error;
    throw new DiagnosticInspectError("invalid_config", "Diagnostic credential file could not be read");
  }
}

/** @param {string} source */
function parseCredentialSource(source) {
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object") return { credential: credentialValue(source, parsed), fileConfig: credentialFileConfig(parsed) };
  } catch {
    // A private file may contain a raw opaque credential, which is the safest
    // format for local operators and avoids a second config schema.
  }
  return { credential: source, fileConfig: {} };
}

/** @param {string} source @param {Record<string, any>} parsed */
function credentialValue(source, parsed) {
  if (typeof parsed.credential === "string") return parsed.credential.trim();
  if (typeof parsed.token === "string") return parsed.token.trim();
  return source;
}

/** @param {Record<string, any>} parsed */
function credentialFileConfig(parsed) {
  const fileConfig = {};
  if (typeof parsed.apiOrigin === "string") fileConfig.apiOrigin = parsed.apiOrigin;
  if (isEnvironment(parsed.environment)) fileConfig.environment = parsed.environment;
  return fileConfig;
}

/** @param {string} credential */
function validateCredential(credential) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+/=-]{7,511}$/u.test(credential)) throw new DiagnosticInspectError("invalid_config", "Diagnostic credential file does not contain a valid opaque credential");
}

/** @param {string} filePath */
async function tightenCredentialFile(filePath) {
  // chmod is intentionally best effort: it tightens a file created by an
  // operator without making inspection fail on read-only local filesystems.
  try {
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  } catch {
    // The read-time mode check above still prevents broad-readable secrets.
  }
}

/**
 * @param {string} filePath
 */
function resolveCredentialPath(filePath) {
  const expanded = filePath.startsWith("~/") ? `${homedir()}${filePath.slice(1)}` : filePath;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/**
 * @param {string} value
 */
function isEnvironment(value) {
  return value === "localhost" || value === "development" || value === "staging" || value === "production";
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export const configEnvironmentVariables = Object.freeze({ CREDENTIAL_FILE_ENV, CREDENTIAL_VALUE_ENV, OPERATOR_TOKEN_ENV, BASE_URL_ENV, ENVIRONMENT_ENV, DEFAULT_CREDENTIAL_FILE });
