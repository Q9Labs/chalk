// @ts-check

import { spawn } from "node:child_process";
import { formatReference, parseReference } from "./reference.mjs";
import { DiagnosticInspectError } from "./errors.mjs";
import { isAllowedObservabilityURL, resolveFeedbackOperatorConfig } from "./feedback-config.mjs";
import { parseFeedbackId, parseFeedbackReport } from "./feedback-parsers.mjs";

/**
 * @typedef {{ kind: "diagnostic" | "journey" | "trace"; value: string; url: string; command: string[] }} FeedbackOpenTarget
 */
/** @typedef {FeedbackOpenTarget & { launched: boolean }} FeedbackOpenResult */
/** @typedef {import("./feedback-parsers.mjs").FeedbackReport} FeedbackReport */
/** @typedef {{ config?: import("./feedback-config.mjs").FeedbackOperatorConfig; baseUrl?: string; environment?: string; credential?: string; credentialFile?: string; observabilityOrigin?: string; observabilityHosts?: string | string[]; fetchImpl?: typeof fetch; fetch?: typeof fetch; env?: NodeJS.ProcessEnv; launch?: boolean; platform?: NodeJS.Platform; spawnImpl?: typeof spawn }} FeedbackOpenOptions */

/**
 * Build a safe observability target. Correlations are intentionally resolved
 * in the same order used by the operator workflow: Diagnostic, Journey, then
 * W3C trace.
 *
 * @param {FeedbackReport} report
 * @param {{ observabilityOrigin: string; observabilityHosts: readonly string[]; environment?: string }} config
 * @returns {FeedbackOpenTarget}
 */
export function buildFeedbackOpenTarget(report, config) {
  const parsed = parseFeedbackReport(report);
  const diagnostic = parsed.diagnostic_reference ?? parsed.correlations.diagnostic_reference;
  return selectTarget(config, diagnostic, parsed.correlations);
}

/** @param {{ observabilityOrigin: string; observabilityHosts: readonly string[]; environment?: string }} config @param {string | undefined} diagnostic @param {import("./feedback-parsers.mjs").FeedbackCorrelations} correlations */
function selectTarget(config, diagnostic, correlations) {
  if (diagnostic) return diagnosticTarget(config, diagnostic);
  if (correlations.journey_id) return journeyTarget(config, correlations.journey_id);
  if (correlations.trace_id) return traceTarget(config, correlations.trace_id);
  throw new DiagnosticInspectError("no_investigation_target", "Feedback report has no supported investigation correlation");
}

/** @param {{ observabilityOrigin: string; observabilityHosts: readonly string[]; environment?: string }} config @param {string} diagnostic @returns {FeedbackOpenTarget} */
function diagnosticTarget(config, diagnostic) {
  const parsedReference = parseReference(diagnostic);
  validateReferenceEnvironment(config.environment, parsedReference.environment);
  const reference = formatReference(parsedReference);
  return target(config, "diagnostic", reference, `/developer/episode-diagnostics/${encodeURIComponent(reference)}`, ["pnpm", "trace:inspect", reference]);
}

/** @param {{ observabilityOrigin: string; observabilityHosts: readonly string[] }} config @param {string} journeyId @returns {FeedbackOpenTarget} */
function journeyTarget(config, journeyId) {
  const value = parseFeedbackId(journeyId);
  return target(config, "journey", value, `/developer/journeys/${encodeURIComponent(value)}`, ["pnpm", "observability:journey", value]);
}

/** @param {{ observabilityOrigin: string; observabilityHosts: readonly string[] }} config @param {string} traceId @returns {FeedbackOpenTarget} */
function traceTarget(config, traceId) {
  return target(config, "trace", traceId, `/developer/traces/${encodeURIComponent(traceId)}`, ["pnpm", "observability:trace", traceId]);
}

/** @param {string | undefined} expected @param {string} actual */
function validateReferenceEnvironment(expected, actual) {
  if (expected && actual !== expected) throw new DiagnosticInspectError("cross_environment", "Feedback diagnostic correlation belongs to another environment");
}

/**
 * Launch a target with argv only. A caller can pass `launch: false` to obtain
 * the exact URL/command without starting a desktop program.
 *
 * @param {FeedbackReport} report
 * @param {FeedbackOpenOptions} [options]
 * @returns {Promise<FeedbackOpenResult>}
 */
export async function openFeedbackReport(report, options = {}) {
  const config = await openConfig(options);
  const openTarget = buildFeedbackOpenTarget(report, config);
  return openResult(openTarget, options);
}

/** @param {FeedbackOpenOptions} options @returns {Promise<import("./feedback-config.mjs").FeedbackOperatorConfig>} */
async function openConfig(options) {
  return options.config ?? resolveFeedbackOperatorConfig(options);
}

/** @param {FeedbackOpenTarget} openTarget @param {FeedbackOpenOptions} options @returns {Promise<FeedbackOpenResult>} */
function openResult(openTarget, options) {
  if (options.launch === false) return Promise.resolve({ ...openTarget, launched: false });
  return launchOpenTarget(openTarget, options.platform ?? process.platform, options.spawnImpl ?? spawn);
}

/** @param {FeedbackOpenTarget} openTarget @param {NodeJS.Platform} platform @param {typeof spawn} spawnImpl @returns {Promise<FeedbackOpenResult>} */
async function launchOpenTarget(openTarget, platform, spawnImpl) {
  try {
    await launchTarget(openTarget.url, platform, spawnImpl);
    return { ...openTarget, launched: true };
  } catch (error) {
    return launchFallback(openTarget, error);
  }
}

/** @param {FeedbackOpenTarget} openTarget @param {unknown} error @returns {FeedbackOpenResult} */
function launchFallback(openTarget, error) {
  const launchError = error instanceof DiagnosticInspectError ? error : new DiagnosticInspectError("transport", "Feedback investigation launcher could not start", { cause: error });
  if (launchError.code !== "transport") throw launchError;
  return { ...openTarget, launched: false };
}

/** @param {{ observabilityOrigin: string; observabilityHosts: readonly string[] }} config @param {FeedbackOpenTarget["kind"]} kind @param {string} value @param {string} path @param {string[]} command @returns {FeedbackOpenTarget} */
function target(config, kind, value, path, command) {
  const url = new URL(path, `${config.observabilityOrigin}/`).toString();
  if (!isAllowedObservabilityURL(url, config.observabilityHosts)) throw new DiagnosticInspectError("host_not_allowed", "Feedback investigation target is not an allowed Chalk observability host");
  return { kind, value, url, command };
}

/** @param {string} url @param {NodeJS.Platform} platform @param {typeof spawn} spawnImpl @returns {Promise<void>} */
function launchTarget(url, platform, spawnImpl) {
  const [command, args] = launcherArguments(platform, url);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { detached: true, stdio: "ignore", shell: false });
    } catch (error) {
      reject(new DiagnosticInspectError("transport", "Feedback investigation launcher could not start", { cause: error }));
      return;
    }
    child.once("error", (error) => reject(new DiagnosticInspectError("transport", "Feedback investigation launcher could not start", { cause: error })));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** @param {NodeJS.Platform} platform @param {string} url */
function launcherArguments(platform, url) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

export { launcherArguments };
