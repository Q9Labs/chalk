export class SyncCapacityError extends Error {
  constructor(readonly limit: "count" | "bytes") {
    super(`pending command ${limit} limit reached`);
    this.name = "SyncCapacityError";
  }
}

export class SyncPendingExpiredError extends Error {
  constructor() {
    super("pending command has exceeded its maximum age");
    this.name = "SyncPendingExpiredError";
  }
}

export class SyncCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncCommandValidationError";
  }
}

export class SyncPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncPersistenceError";
  }
}

export class SyncBrowserCapabilityError extends Error {
  constructor(capability: "IndexedDB" | "WebSocket" | "browser lifecycle") {
    super(`${capability} is unavailable in this runtime`);
    this.name = "SyncBrowserCapabilityError";
  }
}

export class SyncReactNativeCapabilityError extends Error {
  constructor(capability: "WebSocket") {
    super(`React Native ${capability} is unavailable in this runtime`);
    this.name = "SyncReactNativeCapabilityError";
  }
}
