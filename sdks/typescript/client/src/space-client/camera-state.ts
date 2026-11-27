import type { Deferred } from "effect";
import type { ConnectionPorts } from "../connection";

export type CameraOwner = {
  readonly result: Deferred.Deferred<MediaStreamTrack, unknown>;
  readonly cancel: () => void;
  references: number;
};
export type CameraState =
  | { readonly status: "idle" | "ended" }
  | { readonly status: "capturing"; readonly owner: CameraOwner }
  | { readonly status: "live"; readonly owner: CameraOwner; readonly track: MediaStreamTrack; readonly publication: ConnectionPorts["media"] | "initial" | null; readonly onEnded: () => void };
