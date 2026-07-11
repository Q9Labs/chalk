import "../../../tools/contract-codegen/src/typespec-proof/main.tsp";
import "../../../tools/contract-codegen/node_modules/@typespec/http/lib/main.tsp";

using Chalk.Proof;
using TypeSpec.Http;

@syncProtocol("1", "control", "streams.control.cursor", "control_revision", "revision", "base_revision", "exclusive")
@syncConnection(10000, "hello", true, SyncProtocolError, 1012)
namespace Chalk.ContractProof;

@minLength(1)
@maxLength(80)
@pattern("^[a-z0-9][a-z0-9_-]*$")
scalar TenantId extends string;

@minLength(1)
@maxLength(80)
@pattern("^[a-z0-9][a-z0-9_-]*$")
scalar UserId extends string;

@minLength(1)
@maxLength(80)
@pattern("^[a-z0-9][a-z0-9_-]*$")
scalar RoomId extends string;

@minLength(1)
@maxLength(80)
@pattern("^[a-z0-9][a-z0-9_-]*$")
scalar ParticipantId extends string;

@opaqueJson
model OpaqueJson is Record<unknown>;

enum UserRole {
  admin: "admin",
  member: "member",
  owner: "owner",
}

@unionDiscriminator("provider")
union ProviderConfig {
  github: GitHubProviderConfig,
  google: GoogleProviderConfig,
}

model GitHubProviderConfig {
  provider: "github";

  @minValue(1)
  @maxValue(9007199254740991)
  installationId: int64;
}

model GoogleProviderConfig {
  provider: "google";

  @minLength(1)
  @maxLength(128)
  projectId: string;
}

model Tenant {
  id: TenantId;
  childrenById: Record<Tenant>;
  members: User[];
  parent?: Tenant | null;
  settings: OpaqueJson;
}

model User {
  id: UserId;
  tenantId: TenantId;
  role: UserRole;
  displayName: string;
  @format("email")
  email: string;
  manager?: User | null;
  provider: ProviderConfig;
}

model Room {
  id: RoomId;
  tenantId: TenantId;
  ownerId: UserId;
  participants: User[];
  participantsById: Record<User>;

  @minLength(1)
  @maxLength(120)
  title: string;

  @maxLength(2000)
  description?: string | null;

  metadata: OpaqueJson;
}

model CreateRoomRequest {
  @minLength(1)
  @maxLength(120)
  title: string;
  provider: ProviderConfig;
  metadata: OpaqueJson;
}

model TenantResponse {
  tenant: Tenant;
}

model RoomResponse {
  room: Room;
}

model RoomListResponse {
  rooms: Room[];
  nextCursor?: string;
}

@error
@wireError("UNAUTHORIZED", "http", "auth,request")
model HttpUnauthorized {
  code: "UNAUTHORIZED";
  message: string;
  requestId?: string;
}

@error
@wireError("NOT_FOUND", "http", "resource")
model HttpNotFound {
  code: "NOT_FOUND";
  message: string;
  resourceId: string;
}

@error
@wireError("VALIDATION_FAILED", "http", "input")
model ValidationError {
  code: "VALIDATION_FAILED";
  message: string;
  fields: Record<string>;
}

@error
@wireError("RATE_LIMITED", "http", "throttle")
model RateLimitedError {
  code: "RATE_LIMITED";
  message: string;
  retryAfterSeconds: int32;
}

model GetTenantOk {
  @statusCode statusCode: 200;
  @header etag: string;
  @body body: TenantResponse;
}

model ListRoomsOk {
  @statusCode statusCode: 200;
  @header etag: string;
  @header("x-request-id") requestId: string;
  @body body: RoomListResponse;
}

model CreateRoomCreated {
  @statusCode statusCode: 201;
  @header etag: string;
  @header("x-request-id") requestId: string;
  @body body: RoomResponse;
}

model UnauthorizedResponse {
  @statusCode statusCode: 401;
  @header("x-request-id") requestId: string;
  @body body: HttpUnauthorized;
}

model NotFoundResponse {
  @statusCode statusCode: 404;
  @header("x-request-id") requestId: string;
  @body body: HttpNotFound;
}

model ValidationErrorResponse {
  @statusCode statusCode: 400;
  @header("x-request-id") requestId: string;
  @body body: ValidationError;
}

model RateLimitedResponse {
  @statusCode statusCode: 429;
  @header("retry-after") retryAfter: string;
  @body body: RateLimitedError;
}

@route("/v1/tenants")
@useAuth(BearerAuth)
@rateLimit(60, 60)
@bodyLimit(65536)
interface Tenants {
  @operationId("tenants.get")
  @get
  @route("/{tenantId}")
  op getTenant(
    @path tenantId: TenantId,
    @query consistency: "strong",
    @query expand?: "users",
  ): GetTenantOk | UnauthorizedResponse | NotFoundResponse;

  @operationId("rooms.list")
  @get
  @route("/{tenantId}/rooms")
  op listRooms(
    @path tenantId: TenantId,
    @query pageSize: int32,
    @query cursor?: string,
  ): ListRoomsOk | UnauthorizedResponse | ValidationErrorResponse | RateLimitedResponse;

  @operationId("rooms.create")
  @post
  @route("/{tenantId}/rooms")
  op createRoom(
    @path tenantId: TenantId,
    @header("idempotency-key") idempotencyKey: string,
    @body body: CreateRoomRequest,
  ): CreateRoomCreated | UnauthorizedResponse | ValidationErrorResponse | RateLimitedResponse;
}

model SyncControlCursor {
  @minValue(0)
  cursor: int64;
}

model SyncStreams {
  control?: SyncControlCursor;
}

model SyncHello {
  type: "hello";
  protocol: 1;
  token: string;
  streams?: SyncStreams;
}

model SyncParticipant {
  participant_id: ParticipantId;
  display_name: string;
  hand_raised: boolean;
}

model SyncSnapshot {
  control_revision: int64;
  participants: SyncParticipant[];
}

model SyncParticipantJoinedPayload {
  participant_id: ParticipantId;
  display_name: string;
}

model SyncParticipantLeftPayload {
  participant_id: ParticipantId;
}

model SyncHandRaisedPayload {
  participant_id: ParticipantId;
}

model SyncHandLoweredPayload {
  participant_id: ParticipantId;
}

@syncEvent("participant_joined")
model SyncParticipantJoinedEvent {
  type: "event";
  stream: "control";
  name: "participant_joined";
  base_revision: int64;
  revision: int64;
  payload: SyncParticipantJoinedPayload;
}

@syncEvent("participant_left")
model SyncParticipantLeftEvent {
  type: "event";
  stream: "control";
  name: "participant_left";
  base_revision: int64;
  revision: int64;
  payload: SyncParticipantLeftPayload;
}

@syncEvent("hand_raised")
model SyncHandRaisedEvent {
  type: "event";
  stream: "control";
  name: "hand_raised";
  base_revision: int64;
  revision: int64;
  payload: SyncHandRaisedPayload;
}

@syncEvent("hand_lowered")
model SyncHandLoweredEvent {
  type: "event";
  stream: "control";
  name: "hand_lowered";
  base_revision: int64;
  revision: int64;
  payload: SyncHandLoweredPayload;
}

@unionDiscriminator("name")
@syncFrame("event", "server-to-client")
union SyncEvent {
  participant_joined: SyncParticipantJoinedEvent,
  participant_left: SyncParticipantLeftEvent,
  hand_raised: SyncHandRaisedEvent,
  hand_lowered: SyncHandLoweredEvent,
}

model SyncWelcomeSnapshot {
  type: "welcome";
  protocol: 1;
  participant_id: ParticipantId;
  mode: "snapshot";
  snapshot: SyncSnapshot;
}

model SyncWelcomeReplay {
  type: "welcome";
  protocol: 1;
  participant_id: ParticipantId;
  mode: "replay";
  events: SyncEvent[];
  control_revision: int64;
}

@unionDiscriminator("mode")
@syncFrame("welcome", "server-to-client")
union SyncWelcome {
  snapshot: SyncWelcomeSnapshot,
  replay: SyncWelcomeReplay,
}

@syncHello(SyncWelcome)
@syncFrame("hello", "client-to-server")
model SyncHelloFrame is SyncHello;

model RaiseHandCommand {
  type: "command";
  command_id: string;
  name: "raise_hand";
  payload?: OpaqueJson;
}

model LowerHandCommand {
  type: "command";
  command_id: string;
  name: "lower_hand";
  payload?: OpaqueJson;
}

model SyncAckCommitted {
  type: "ack";
  command_id: string;
  result: "committed";
  revision: int64;
}

model SyncAckDuplicate {
  type: "ack";
  command_id: string;
  result: "duplicate";
  revision: int64;
}

model SyncAckRejected {
  type: "ack";
  command_id: string;
  result: "rejected";
  reason: string;
}

@unionDiscriminator("result")
@syncFrame("ack", "server-to-client")
union SyncAck {
  committed: SyncAckCommitted,
  duplicate: SyncAckDuplicate,
  rejected: SyncAckRejected,
}

@syncCommand("raise_hand", SyncAck)
@commandError(SyncProtocolError)
model RaiseHandCommandMessage is RaiseHandCommand;

@syncCommand("lower_hand", SyncAck)
@commandError(SyncProtocolError)
model LowerHandCommandMessage is LowerHandCommand;

@unionDiscriminator("name")
@syncFrame("command", "client-to-server")
union SyncCommand {
  raise_hand: RaiseHandCommandMessage,
  lower_hand: LowerHandCommandMessage,
}

@error
@wireError("protocol_error", "sync", "frame")
@syncFrame("error", "server-to-client")
model SyncProtocolError {
  type: "error";
  code: "protocol_error";
  message: string;
}

@syncFrame("ping", "client-to-server")
model SyncPing {
  type: "ping";
}

@syncFrame("pong", "server-to-client")
model SyncPong {
  type: "pong";
}

@error
@wireError("PROTOCOL", "sync", "connection")
@closeCode(1002, "protocol error or hello timeout")
model SyncProtocolClose {
  code: string;
  message: string;
}

@error
@wireError("UNSUPPORTED_DATA", "sync", "connection")
@closeCode(1003, "text frames only")
model SyncUnsupportedDataClose {
  code: string;
  message: string;
}

@error
@wireError("UNAUTHORIZED", "sync", "connection")
@closeCode(1008, "unauthorized")
model SyncUnauthorizedClose {
  code: string;
  message: string;
}

@error
@wireError("SERVER_FAILURE", "sync", "connection")
@closeCode(1011, "room server failure")
model SyncServerFailureClose {
  code: string;
  message: string;
}

@error
@wireError("ROOM_RESTARTING", "sync", "connection")
@closeCode(1012, "room restarting; reconnect and re-snapshot")
model SyncRoomRestartClose {
  code: string;
  message: string;
}
