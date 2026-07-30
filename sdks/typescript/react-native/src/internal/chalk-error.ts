export class ChalkErrorClass extends Error {
  static wrap(cause: unknown): ChalkErrorClass {
    if (cause instanceof ChalkErrorClass) return cause;
    if (cause instanceof Error) return new ChalkErrorClass(cause.message);
    return new ChalkErrorClass(String(cause));
  }
}

export type ChalkError = ChalkErrorClass;
