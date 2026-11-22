import type { V1ControlState } from "./v1-types";

export type Head = {
  readonly revision: number;
  readonly state_schema_version: number;
  readonly state_digest: string;
};

export function sameHead(control: V1ControlState | null, head: Head): boolean {
  return control !== null && control.revision === head.revision && control.stateSchemaVersion === head.state_schema_version && control.stateDigest === head.state_digest;
}
export function sameRawHead(left: Head, right: Head): boolean {
  return left.revision === right.revision && left.state_schema_version === right.state_schema_version && left.state_digest === right.state_digest;
}
