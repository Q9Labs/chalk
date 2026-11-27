import type { V1Deferred as Deferred } from "./v1-deferred";
import type { Head } from "./v1-frame-head";
import type { SyncV1ClientFrame } from "../generated/sync";
import type { V1DirectedRequestResult } from "./v1-types";

export type RequestDeferred = Deferred<V1DirectedRequestResult> & {
  readonly frame: SyncV1ClientFrame;
};
export type Recovery = {
  readonly id: string;
  readonly head: Head;
  replayEvents: number;
  replayBytes: number;
  controlComplete: boolean;
};
export type CommandOptions = {
  readonly commandId?: string;
};
export type RequestOptions = {
  readonly requestId?: string;
};
