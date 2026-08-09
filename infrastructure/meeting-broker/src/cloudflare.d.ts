declare module "cloudflare:workers" {
  export type SqlStorageCursor<T> = {
    one(): T;
    toArray(): T[];
  };

  export type SqlStorage = {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
  };

  export type DurableObjectStorage = {
    readonly sql: SqlStorage;
    deleteAlarm(): Promise<void>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
  };

  export type DurableObjectState = {
    readonly storage: DurableObjectStorage;
  };

  export class DurableObject<Env = unknown> {
    constructor(state: DurableObjectState, environment: Env);
  }
}
