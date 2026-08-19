// @ts-check

const EXIT_CODES = Object.freeze({
  malformed: 2,
  invalid_query: 2,
  invalid_config: 2,
  unsafe_output: 2,
  invalid_feedback: 2,
  host_not_allowed: 2,
  no_investigation_target: 2,
  unauthorized: 3,
  cross_environment: 3,
  expired: 3,
  not_found: 4,
  ambiguous: 4,
  checksum_mismatch: 5,
  size_limit: 5,
  invalid_contract: 5,
  transport: 5,
  server: 5,
});

/**
 * Errors from the diagnostic resolver are deliberately typed so the CLI can
 * fail closed without ever printing an upstream response body.
 */
export class DiagnosticInspectError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ exitCode?: number; cause?: unknown } | undefined} [options]
   */
  constructor(code, message, options = undefined) {
    super(message, errorOptions(options));
    this.name = "DiagnosticInspectError";
    this.code = code;
    this.exitCode = options?.exitCode ?? exitCodeFor(code);
  }
}

/**
 * @param {string} code
 */
export function exitCodeFor(code) {
  return EXIT_CODES[code] ?? 1;
}

/** @param {{ cause?: unknown } | undefined } options */
function errorOptions(options) {
  if (!options || options.cause === undefined) return undefined;
  return { cause: options.cause };
}

/**
 * @param {unknown} error
 */
export function asDiagnosticInspectError(error) {
  if (error instanceof DiagnosticInspectError) return error;
  return new DiagnosticInspectError("transport", "Diagnostic service could not be reached", { cause: error });
}
