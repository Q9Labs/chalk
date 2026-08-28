class FeatureDispositionError extends Error {
  constructor(kind, feature, message) {
    super(message);
    this.name = `${kind[0].toUpperCase()}${kind.slice(1)}FeatureError`;
    this.kind = kind;
    this.feature = feature;
  }
}

export class FeatureUnreachableError extends FeatureDispositionError {
  constructor(feature, message) {
    super("unreachable", feature, message);
  }
}

export class FeatureUnsupportedError extends FeatureDispositionError {
  constructor(feature, message) {
    super("unsupported", feature, message);
  }
}

export class StepFailure extends Error {
  constructor(label, cause) {
    super(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StepFailure";
    this.label = label;
    this.cause = cause;
  }
}

export class TraceLifecycleError extends Error {
  constructor(message, { cause, result } = {}) {
    super(message, { cause });
    this.name = "TraceLifecycleError";
    this.result = result;
  }
}

export function isFeatureDispositionError(value) {
  return value instanceof FeatureDispositionError;
}

export function aggregateFailures(label, failures) {
  if (failures.length === 0) return null;
  return new AggregateError(failures, `${label}: ${failures.length} failure${failures.length === 1 ? "" : "s"}`);
}
