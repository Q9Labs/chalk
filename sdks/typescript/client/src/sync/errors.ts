export class SyncCapacityError extends Error {
  readonly _tag = "SyncCapacityError";

  constructor(readonly limit: "count" | "bytes") {
    super(`pending command ${limit} limit reached`);
    this.name = "SyncCapacityError";
  }
}

export class SyncPendingExpiredError extends Error {
  readonly _tag = "SyncPendingExpiredError";

  constructor() {
    super("pending command has exceeded its maximum age");
    this.name = "SyncPendingExpiredError";
  }
}

export class SyncCommandValidationError extends Error {
  readonly _tag = "SyncCommandValidationError";

  constructor(message: string) {
    super(message);
    this.name = "SyncCommandValidationError";
  }
}

export class SyncPersistenceError extends Error {
  readonly _tag = "SyncPersistenceError";

  constructor(message: string) {
    super(message);
    this.name = "SyncPersistenceError";
  }
}

export class SyncBrowserCapabilityError extends Error {
  readonly _tag = "SyncBrowserCapabilityError";

  constructor(capability: "IndexedDB" | "WebSocket" | "browser lifecycle") {
    super(`${capability} is unavailable in this runtime`);
    this.name = "SyncBrowserCapabilityError";
  }
}

export class SyncReactNativeCapabilityError extends Error {
  readonly _tag = "SyncReactNativeCapabilityError";

  constructor(capability: "WebSocket") {
    super(`React Native ${capability} is unavailable in this runtime`);
    this.name = "SyncReactNativeCapabilityError";
  }
}
