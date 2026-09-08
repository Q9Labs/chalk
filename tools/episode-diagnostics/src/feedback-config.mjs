// @ts-check

import { resolveOperatorConfig } from "./config.mjs";
import { DiagnosticInspectError } from "./errors.mjs";

const OBSERVABILITY_URL_ENV = "CHALK_OBSERVABILITY_URL";
const DIAGNOSTICS_OBSERVABILITY_URL_ENV = "CHALK_DIAGNOSTICS_OBSERVABILITY_URL";
const OBSERVABILITY_HOSTS_ENV = "CHALK_OBSERVABILITY_HOSTS";
const DIAGNOSTICS_OBSERVABILITY_HOSTS_ENV = "CHALK_DIAGNOSTICS_OBSERVABILITY_HOSTS";
const FEEDBACK_OBSERVABILITY_URL_ENV = "CHALK_FEEDBACK_OBSERVABILITY_URL";
const FEEDBACK_OBSERVABILITY_HOSTS_ENV = "CHALK_FEEDBACK_OBSERVABILITY_HOSTS";

/**
 * @typedef {import("./config.mjs").DiagnosticOperatorConfig & { observabilityOrigin: string; observabilityHosts: readonly string[] }} FeedbackOperatorConfig
 */

/**
 * Resolve the shared diagnostics credential and service-origin checks, then
 * add the explicit destination allowlist used by `feedback open`.
 *
 * @param {{ config?: FeedbackOperatorConfig; baseUrl?: string; environment?: string; credential?: string; credentialFile?: string; observabilityOrigin?: string; observabilityHosts?: string | string[]; fetchImpl?: typeof fetch; fetch?: typeof fetch; env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<FeedbackOperatorConfig>}
 */
export async function resolveFeedbackOperatorConfig(options = {}) {
  if (options.config) return configuredFeedbackOperatorConfig(options);
  const base = await resolveOperatorConfig({ ...options, fetchImpl: options.fetchImpl ?? options.fetch });
  const env = options.env ?? process.env;
  return withFeedbackObservability(base, options, env);
}

/** @param {{ config: FeedbackOperatorConfig; observabilityOrigin?: string; observabilityHosts?: string | string[] }} options @returns {FeedbackOperatorConfig} */
function configuredFeedbackOperatorConfig(options) {
  if (options.config.observabilityOrigin && options.config.observabilityHosts) return options.config;
  const origin = normalizeOrigin(options.observabilityOrigin ?? options.config.baseUrl);
  const hosts = observabilityHosts(options.observabilityHosts, origin);
  return { ...options.config, observabilityOrigin: origin, observabilityHosts: hosts };
}

/** @param {import("./config.mjs").DiagnosticOperatorConfig} base @param {{ observabilityOrigin?: string; observabilityHosts?: string | string[] }} options @param {NodeJS.ProcessEnv} env @returns {FeedbackOperatorConfig} */
function withFeedbackObservability(base, options, env) {
  const origin = normalizeOrigin(observabilityOriginValue(options, env, base.baseUrl));
  const hosts = observabilityHosts(observabilityHostsValue(options, env), origin);
  return { ...base, observabilityOrigin: origin, observabilityHosts: hosts };
}

/** @param {{ observabilityOrigin?: string }} options @param {NodeJS.ProcessEnv} env @param {string} fallback @returns {string} */
function observabilityOriginValue(options, env, fallback) {
  return options.observabilityOrigin ?? environmentOriginValue(env) ?? fallback;
}

/** @param {NodeJS.ProcessEnv} env @returns {string | undefined} */
function environmentOriginValue(env) {
  return env[FEEDBACK_OBSERVABILITY_URL_ENV] ?? env[DIAGNOSTICS_OBSERVABILITY_URL_ENV] ?? env[OBSERVABILITY_URL_ENV];
}

/** @param {{ observabilityHosts?: string | string[] }} options @param {NodeJS.ProcessEnv} env @returns {string | string[] | undefined} */
function observabilityHostsValue(options, env) {
  return options.observabilityHosts ?? env[FEEDBACK_OBSERVABILITY_HOSTS_ENV] ?? env[DIAGNOSTICS_OBSERVABILITY_HOSTS_ENV] ?? env[OBSERVABILITY_HOSTS_ENV];
}

/** @param {string | string[] | undefined} value @param {string} origin @returns {readonly string[]} */
function observabilityHosts(value, origin) {
  return value === undefined ? Object.freeze([origin]) : Object.freeze(parseObservabilityAllowlist(value));
}

/**
 * @param {string | string[]} values
 * @returns {string[]}
 */
export function parseObservabilityAllowlist(values) {
  const normalized = normalizeAllowlistEntries(allowlistEntries(values));
  if (normalized.length === 0) throw new DiagnosticInspectError("invalid_config", "Feedback observability host allowlist is empty");
  return [...new Set(normalized)];
}

/** @param {string | string[]} values @returns {string[]} */
function allowlistEntries(values) {
  return Array.isArray(values) ? values : values.split(",");
}

/** @param {string[]} entries @returns {string[]} */
function normalizeAllowlistEntries(entries) {
  const normalized = [];
  for (const raw of entries) {
    const value = raw.trim();
    if (value) normalized.push(normalizeAllowlistEntry(value));
  }
  return normalized;
}

/**
 * @param {string} value
 */
function normalizeAllowlistEntry(value) {
  if (value.includes("/")) {
    const origin = normalizeOrigin(value);
    return origin;
  }
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/u.test(value)) throw new DiagnosticInspectError("invalid_config", "Feedback observability host allowlist contains an invalid entry");
  return value.toLowerCase();
}

/** @param {string} value */
function normalizeOrigin(value) {
  const parsed = parseOriginURL(value);
  validateOriginProtocol(parsed);
  validateOriginCredentials(parsed);
  return parsed.origin;
}

/** @param {string} value @returns {URL} */
function parseOriginURL(value) {
  try {
    return new URL(value);
  } catch {
    throw new DiagnosticInspectError("invalid_config", "Feedback observability URL is invalid");
  }
}

/** @param {URL} parsed */
function validateOriginProtocol(parsed) {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new DiagnosticInspectError("invalid_config", "Feedback observability URL must use HTTP or HTTPS");
}

/** @param {URL} parsed */
function validateOriginCredentials(parsed) {
  if (hasForbiddenOriginData(parsed)) throw new DiagnosticInspectError("invalid_config", "Feedback observability URL must not include credentials or query data");
}

/** @param {URL} parsed */
function hasForbiddenOriginData(parsed) {
  return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
}

/**
 * @param {string} value
 */
export function isAllowedObservabilityURL(value, allowedHosts) {
  const parsed = allowedURL(value);
  return parsed !== undefined && allowedHosts.some((entry) => allowedHostMatch(parsed, entry));
}

/** @param {string} value @returns {URL | undefined} */
function allowedURL(value) {
  const parsed = parseAllowedURL(value);
  if (!parsed || !allowedProtocol(parsed) || hasForbiddenOriginData(parsed)) return undefined;
  return parsed;
}

/** @param {string} value @returns {URL | undefined} */
function parseAllowedURL(value) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** @param {URL} parsed */
function allowedProtocol(parsed) {
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** @param {URL} parsed @param {string} entry */
function allowedHostMatch(parsed, entry) {
  if (entry.includes("://")) return parsed.origin === entry;
  return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`.toLowerCase() === entry;
}

export const feedbackConfigEnvironmentVariables = Object.freeze({
  OBSERVABILITY_URL_ENV,
  DIAGNOSTICS_OBSERVABILITY_URL_ENV,
  OBSERVABILITY_HOSTS_ENV,
  DIAGNOSTICS_OBSERVABILITY_HOSTS_ENV,
  FEEDBACK_OBSERVABILITY_URL_ENV,
  FEEDBACK_OBSERVABILITY_HOSTS_ENV,
});
