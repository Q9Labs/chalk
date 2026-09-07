export type V1Deferred<T> = {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
};

export function resolveV1Deferred<T>(deferred: V1Deferred<T>, value: T): void {
  if (deferred.settled) return;
  deferred.settled = true;
  deferred.resolve(value);
}

export function rejectV1Deferred<T>(deferred: V1Deferred<T>, error: Error): void {
  if (deferred.settled) return;
  deferred.settled = true;
  deferred.reject(error);
}
