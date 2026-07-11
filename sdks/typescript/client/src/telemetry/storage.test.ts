import type { TelemetryEvent } from "./types";
import { describe, expect, it } from "vitest";
import { createBrowserRuntimeTelemetryStorage, createBrowserTelemetryStorage, createKeyValueTelemetryStorage, type TelemetryStorage } from "./storage";

describe("createKeyValueTelemetryStorage", () => {
  it("surfaces malformed persisted data for the client health boundary", async () => {
    const storage = createKeyValueTelemetryStorage({ getItem: () => "not-json", setItem: () => undefined });
    await expect(storage.load()).rejects.toThrow("not valid JSON");
  });
});

describe("createBrowserTelemetryStorage", () => {
  it("stays disabled when the runtime blocks localStorage access", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access denied", "SecurityError");
      },
    });

    try {
      expect(createBrowserTelemetryStorage()).toBeUndefined();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("createBrowserRuntimeTelemetryStorage", () => {
  it.each([
    ["primary", "chalk.web.telemetry.v1"],
    ["sibling", "chalk.web.telemetry.v1.malformed"],
  ])("removes a malformed $0 queue while recovering valid siblings and saving future events", async (_queueLocation, malformedKey) => {
    const localStorage = createStorage();
    const restore = installBrowserStorage(localStorage);

    try {
      localStorage.setItem(malformedKey, "not-json");
      localStorage.setItem("chalk.web.telemetry.v1.valid-sibling", JSON.stringify([event("recovered")]));

      const queue = createRuntimeStorage();
      await expect(queue.load()).resolves.toEqual([event("recovered")]);
      expect(localStorage.getItem(malformedKey)).toBeNull();

      await queue.save([event("recovered"), event("future")]);
      expect(telemetryQueueKeys(localStorage)).toHaveLength(1);

      const reloadedQueue = createRuntimeStorage();
      await expect(reloadedQueue.load()).resolves.toEqual([event("recovered"), event("future")]);
    } finally {
      restore();
    }
  });

  it("removes an adopted queue that becomes malformed before a future save", async () => {
    const localStorage = createStorage();
    const restore = installBrowserStorage(localStorage);
    const siblingKey = "chalk.web.telemetry.v1.sibling";

    try {
      localStorage.setItem(siblingKey, JSON.stringify([event("recovered")]));

      const queue = createRuntimeStorage();
      await expect(queue.load()).resolves.toEqual([event("recovered")]);
      localStorage.setItem(siblingKey, "not-json");

      await queue.save([event("recovered"), event("future")]);
      expect(localStorage.getItem(siblingKey)).toBeNull();

      const reloadedQueue = createRuntimeStorage();
      await expect(reloadedQueue.load()).resolves.toEqual([event("recovered"), event("future")]);
    } finally {
      restore();
    }
  });

  it("keeps simultaneous runtimes in separate queues and recovers them after the tabs close", async () => {
    const localStorage = createStorage();
    const restore = installBrowserStorage(localStorage);

    try {
      const firstTabQueue = createRuntimeStorage();
      const secondTabQueue = createRuntimeStorage();
      await firstTabQueue.load();
      await secondTabQueue.load();

      await firstTabQueue.save([event("first-tab"), event("shared")]);
      await secondTabQueue.save([event("second-tab"), event("shared")]);
      expect(telemetryQueueKeys(localStorage)).toHaveLength(2);

      const recoveredQueue = createRuntimeStorage();
      const recoveredEvents = await recoveredQueue.load();
      expect(recoveredEvents.map((event) => event.event_id)).toEqual(["first-tab", "shared", "second-tab"]);

      await recoveredQueue.save([...recoveredEvents, event("recovered")]);
      expect(telemetryQueueKeys(localStorage)).toHaveLength(1);

      const reloadQueue = createRuntimeStorage();
      const reloadedEvents = await reloadQueue.load();
      expect(reloadedEvents.map((event) => event.event_id)).toEqual(["first-tab", "shared", "second-tab", "recovered"]);
    } finally {
      restore();
    }
  });

  it("retains an event written after adoption until a later runtime can deliver it", async () => {
    const localStorage = createStorage();
    const restore = installBrowserStorage(localStorage);

    try {
      const activeTabQueue = createRuntimeStorage();
      await activeTabQueue.load();
      await activeTabQueue.save([event("started")]);

      const recoveringQueue = createRuntimeStorage();
      const recoveredEvents = await recoveringQueue.load();
      expect(recoveredEvents.map((event) => event.event_id)).toEqual(["started"]);

      await activeTabQueue.save([event("started"), event("late")]);
      await recoveringQueue.save([...recoveredEvents, event("recovery")]);
      await recoveringQueue.save([]);

      const reloadQueue = createRuntimeStorage();
      await expect(reloadQueue.load()).resolves.toEqual([event("late")]);
    } finally {
      restore();
    }
  });
});

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  } as Storage;
}

function createRuntimeStorage(): TelemetryStorage {
  const storage = createBrowserRuntimeTelemetryStorage("chalk.web.telemetry.v1");
  if (!storage) throw new Error("Browser localStorage test setup failed");
  return storage;
}

function installBrowserStorage(localStorage: Storage): () => void {
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });

  return () => {
    if (localStorageDescriptor) Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function telemetryQueueKeys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null && key.startsWith("chalk.web.telemetry.v1."));
}

function event(eventId: string): TelemetryEvent {
  return {
    event_id: eventId,
    first_observed_layer: "client",
    journey_id: "00000000-0000-4000-8000-000000000001",
    name: "journey.started",
    occurred_at: "2026-07-11T00:00:00.000Z",
    origin_kind: "client",
    phase: "root",
    sequence: 1,
    state: "started",
    upstream_visibility: "local",
    version: 1,
  };
}
