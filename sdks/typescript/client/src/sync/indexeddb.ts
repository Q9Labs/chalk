import { SyncBrowserCapabilityError, SyncPersistenceError } from "./errors";
import type { PendingCommand } from "./types";
import { isPendingCommand } from "./pending-command-validation";
import { copyPendingCommand, type PendingCommandStore } from "./persistence";

const DATABASE_VERSION = 2;
const STORE_NAME = "pending_commands";
const SCOPE_INDEX = "by_scope";

export type IndexedDbPendingCommandStoreOptions = {
  readonly scope: string;
  readonly databaseName?: string;
  readonly indexedDb?: IDBFactory;
};

export class IndexedDbPendingCommandStore implements PendingCommandStore {
  readonly #databaseName: string;
  readonly #scope: string;
  readonly #indexedDb: IDBFactory | undefined;
  #database: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbPendingCommandStoreOptions) {
    if (options.scope.length === 0) {
      throw new SyncPersistenceError("IndexedDB pending-command scope must not be empty");
    }
    this.#databaseName = options.databaseName ?? "chalk-sync-v2";
    this.#scope = options.scope;
    this.#indexedDb = options.indexedDb ?? globalThis.indexedDB;
  }

  async load(): Promise<readonly PendingCommand[]> {
    const database = await this.#open();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).index(SCOPE_INDEX).getAll(this.#scope);
    const [records] = await Promise.all([requestResult<unknown[]>(request), transactionComplete(transaction)]);
    return records.filter(isPendingCommand).map(copyPendingCommand);
  }

  async put(command: PendingCommand): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ scope: this.#scope, ...copyPendingCommand(command) });
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

function openDatabase(indexedDb: IDBFactory | undefined, name: string): Promise<IDBDatabase> {
  if (!indexedDb) {
    return Promise.reject(new SyncBrowserCapabilityError("IndexedDB"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => upgradePendingCommandDatabase(request);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(new SyncPersistenceError("unable to open IndexedDB pending-command storage"));
    request.onblocked = () => reject(new SyncPersistenceError("IndexedDB pending-command storage is blocked"));
  });
}

function upgradePendingCommandDatabase(request: IDBOpenDBRequest): void {
  const database = request.result;
  if (hasIncompatiblePendingCommandStore(database, request.transaction)) {
    database.deleteObjectStore(STORE_NAME);
  }
  if (!database.objectStoreNames.contains(STORE_NAME)) {
    createPendingCommandStore(database);
    return;
  }
  addScopeIndex(request.transaction);
}

function hasIncompatiblePendingCommandStore(database: IDBDatabase, transaction: IDBTransaction | null): boolean {
  if (!database.objectStoreNames.contains(STORE_NAME)) {
    return false;
  }
  const store = transaction?.objectStore(STORE_NAME);
  return !store || !Array.isArray(store.keyPath);
}

function createPendingCommandStore(database: IDBDatabase): void {
  const store = database.createObjectStore(STORE_NAME, { keyPath: ["scope", "commandId"] });
  store.createIndex(SCOPE_INDEX, "scope", { unique: false });
}

function addScopeIndex(transaction: IDBTransaction | null): void {
  const store = transaction?.objectStore(STORE_NAME);
  if (store && !store.indexNames.contains(SCOPE_INDEX)) {
    store.createIndex(SCOPE_INDEX, "scope", { unique: false });
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new SyncPersistenceError("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new SyncPersistenceError("IndexedDB transaction failed"));
    transaction.onabort = () => reject(new SyncPersistenceError("IndexedDB transaction was aborted"));
  });
}
