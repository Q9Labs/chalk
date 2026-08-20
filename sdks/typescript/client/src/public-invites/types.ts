import type { AccessGrant } from "../access/grant.js";
import type { JourneyTelemetryContext } from "../telemetry/types.js";
import type {
  ApproveSpacePublicAdmissionRequestError,
  ArriveBySpacePublicInviteError,
  ArrivalInvalidHandleError,
  ArrivalUnavailableError,
  CreatePublicSpaceError,
  DenySpacePublicAdmissionRequestError,
  GetPublicStatusError,
  GetPublicStatusResponse,
  GetSpacePublicInviteArrivalError,
  LeaveSpacePublicInviteArrivalError,
  PublicSpaceArrival as GeneratedPublicSpaceArrival,
  PublicSpaceCreated as GeneratedPublicSpaceCreated,
  RefreshSpacePublicInviteAccessError,
  SpacePublicInviteUnavailableError,
} from "../generated/schemas.js";

export type ChalkPublicClientRuntime = "browser" | "react-native";

export type ChalkPublicClientOptions = {
  readonly baseUrl: string | URL;
  readonly credentials?: RequestCredentials;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly guestCredential?: string;
  readonly runtime?: ChalkPublicClientRuntime;
  readonly telemetry?: JourneyTelemetryContext;
};

export type ChalkPublicIdempotencyOptions = {
  readonly idempotencyKey?: string;
};

export type CreatePublicSpaceInput = {
  readonly displayName: string;
};

export type ArriveBySpacePublicInviteInput = {
  readonly displayName: string;
  readonly spaceInviteToken: string;
};

export type PublicArrivalReference = {
  readonly arrivalHandle: string;
  readonly guestCredential?: string;
};

export type PublicArrivalOptions = ChalkPublicIdempotencyOptions & {
  readonly arrivalHandle?: string;
  readonly guestCredential?: string;
};

export type PublicRefreshAccessInput = {
  readonly arrivalHandle?: string;
  readonly guestCredential?: string;
  readonly mediaProof: string;
};

export type PublicLeaveOptions = {
  readonly keepalive?: boolean;
};

export type PublicSpaceArrival = Omit<GeneratedPublicSpaceArrival, "access"> & {
  readonly access?: AccessGrant | null;
};

export type PublicSpaceCreated = Omit<GeneratedPublicSpaceCreated, "arrival"> & {
  readonly arrival: PublicSpaceArrival;
};

export type PublicStatus = GetPublicStatusResponse;

export type CreatePublicSpace = (input: CreatePublicSpaceInput, options?: ChalkPublicIdempotencyOptions) => Promise<PublicSpaceCreated>;
export type ArriveBySpacePublicInvite = (input: ArriveBySpacePublicInviteInput, options?: PublicArrivalOptions) => Promise<PublicSpaceArrival>;
export type GetSpacePublicInviteArrival = (reference: PublicArrivalReference | string) => Promise<PublicSpaceArrival>;
export type RefreshSpacePublicInviteAccess = (input: PublicRefreshAccessInput | string, options?: PublicArrivalOptions) => Promise<AccessGrant>;
export type LeaveSpacePublicInviteArrival = (reference: PublicArrivalReference | string, options?: PublicLeaveOptions) => Promise<void>;

export type ChalkPublicClient = {
  readonly arrive: ArriveBySpacePublicInvite;
  readonly arriveBySpacePublicInvite: ArriveBySpacePublicInvite;
  readonly create: CreatePublicSpace;
  readonly createPublicSpace: CreatePublicSpace;
  readonly getPublicStatus: () => Promise<PublicStatus>;
  readonly getSpacePublicInviteArrival: GetSpacePublicInviteArrival;
  readonly leave: LeaveSpacePublicInviteArrival;
  readonly leaveSpacePublicInviteArrival: LeaveSpacePublicInviteArrival;
  readonly refresh: RefreshSpacePublicInviteAccess;
  readonly refreshSpacePublicInviteAccess: RefreshSpacePublicInviteAccess;
  readonly status: GetSpacePublicInviteArrival;
};

export type ChalkPublicInviteError =
  | ApproveSpacePublicAdmissionRequestError
  | ArriveBySpacePublicInviteError
  | DenySpacePublicAdmissionRequestError
  | CreatePublicSpaceError
  | GetPublicStatusError
  | GetSpacePublicInviteArrivalError
  | LeaveSpacePublicInviteArrivalError
  | RefreshSpacePublicInviteAccessError
  | ArrivalInvalidHandleError
  | ArrivalUnavailableError
  | SpacePublicInviteUnavailableError;

export type PublicSpaceArrivalAccess = PublicSpaceArrival["access"];
