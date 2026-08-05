import { encodeV1ClientFrame } from "./v1-codec";
import type { ReactNativeAsyncStorage } from "./react-native";
import type { V1PendingTarget, V1PendingTargetStore, V1TargetCommand } from "./v1-types";

const STORE_NAME = "pending_targets";
const SCOPE_INDEX = "by_scope";
const STORAGE_PREFIX = "chalk-sync-v1:pending-targets:";

export type IndexedDbV1PendingTargetStoreOptions = { readonly scope: string; readonly databaseName?: string; readonly indexedDb?: IDBFactory };

export class IndexedDbV1PendingTargetStore implements V1PendingTargetStore {
  readonly #scope: string;
  readonly #databaseName: string;
  readonly #indexedDb: IDBFactory | undefined;
  #database: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbV1PendingTargetStoreOptions) {
    if (!options.scope) throw new Error("v1 pending-target scope must not be empty");
    this.#scope = options.scope;
    this.#databaseName = options.databaseName ?? "chalk-sync-v1";
    this.#indexedDb = options.indexedDb ?? globalThis.indexedDB;
  }

  async load(): Promise<readonly V1PendingTarget[]> {
    const database = await this.#open();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const records = await requestResult<unknown[]>(transaction.objectStore(STORE_NAME).index(SCOPE_INDEX).getAll(this.#scope));
    await transactionComplete(transaction);
    return records.filter(isPendingTarget).map(copyPendingTarget);
  }

  async put(command: V1PendingTarget): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ scope: this.#scope, ...copyPendingTarget(command) });
    await transactionComplete(transaction);
  }

  async remove(commandId: string): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete([this.#scope, commandId]);
    await transactionComplete(transaction);
  }

  #open(): Promise<IDBDatabase> {
    this.#database ??= openDatabase(this.#indexedDb, this.#databaseName);
    return this.#database;
  }
}

export type AsyncStorageV1PendingTargetStoreOptions = { readonly scope: string; readonly storage: ReactNativeAsyncStorage };

export class AsyncStorageV1PendingTargetStore implements V1PendingTargetStore {
  readonly #storage: ReactNativeAsyncStorage;
  readonly #key: string;
  #operations = Promise.resolve();

  constructor(options: AsyncStorageV1PendingTargetStoreOptions) {
    if (!options.scope) throw new Error("v1 pending-target scope must not be empty");
    this.#storage = options.storage;
    this.#key = `${STORAGE_PREFIX}${options.scope}`;
  }

  load(): Promise<readonly V1PendingTarget[]> {
    return this.#enqueue(async () => this.#read());
  }

  put(command: V1PendingTarget): Promise<void> {
    return this.#enqueue(async () => {
      const commands = await this.#read();
      const next = [...commands.filter((candidate) => candidate.commandId !== command.commandId), copyPendingTarget(command)];
      await this.#write(next);
    });
  }

  remove(commandId: string): Promise<void> {
    return this.#enqueue(async () => this.#write((await this.#read()).filter((command) => command.commandId !== commandId)));
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #read(): Promise<V1PendingTarget[]> {
    const stored = await this.#storage.getItem(this.#key);
    if (stored === null) return [];
    const value: unknown = JSON.parse(stored);
    if (!Array.isArray(value)) throw new Error("v1 pending-target storage is invalid");
    return value.filter(isPendingTarget).map(copyPendingTarget);
  }

  async #write(commands: readonly V1PendingTarget[]): Promise<void> {
    if (commands.length === 0) {
      await this.#storage.removeItem(this.#key);
      return;
    }
    await this.#storage.setItem(this.#key, JSON.stringify(commands.map(copyPendingTarget)));
  }
}

function isPendingTarget(value: unknown): value is V1PendingTarget {
  if (!isRecord(value) || typeof value.commandId !== "string" || typeof value.createdAt !== "number" || typeof value.bytes !== "number" || !isTargetCommand(value.command)) return false;
  try {
    encodeV1ClientFrame({ type: "command", command_id: value.commandId, name: value.command.name, payload: value.command.payload });
    return Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && Number.isSafeInteger(value.bytes) && value.bytes > 0;
  } catch {
    return false;
  }
}

function isTargetCommand(value: unknown): value is V1TargetCommand {
  return isRecord(value) && typeof value.name === "string" && isRecord(value.payload) && ["set_hand_raised", "set_display_name", "set_admission_policy", "assign_roles"].includes(value.name);
}

function copyPendingTarget(command: V1PendingTarget): V1PendingTarget {
  return structuredClone(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openDatabase(indexedDb: IDBFactory | undefined, name: string): Promise<IDBDatabase> {
  if (!indexedDb) return Promise.reject(new Error("IndexedDB is unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(name, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: ["scope", "commandId"] });
      store.createIndex(SCOPE_INDEX, "scope", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("unable to open v1 pending-target storage"));
    request.onblocked = () => reject(new Error("v1 pending-target storage is blocked"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("v1 pending-target request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("v1 pending-target transaction failed"));
    transaction.onabort = () => reject(new Error("v1 pending-target transaction aborted"));
  });
}
