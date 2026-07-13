export class SyncBrowserCapabilityError extends Error {
  readonly _tag = "SyncBrowserCapabilityError";

  constructor(capability: "WebSocket" | "browser lifecycle") {
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
