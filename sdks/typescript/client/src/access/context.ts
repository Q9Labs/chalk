export type AccessReason = "join" | "refresh" | "retry";
export type AccessContext = {
  readonly space: string;
  readonly reason: AccessReason;
  /** Forward to the access endpoint so media recovery can obtain a fresh connection. */
  readonly replaceMediaConnection: boolean;
  /** Automatic replacement succeeds only while this media binding is current. Omit for explicit takeover. */
  readonly expectedMediaConnectionId?: string;
  /** Forward unchanged for replay-safe recovery. Never log credentials. */
  readonly currentMediaToken?: string;
  readonly signal?: AbortSignal;
};
