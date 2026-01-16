/**
 * Effect module exports for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect
 */

// Errors
export {
  // Error types
  ConnectionError,
  AuthError,
  MediaError,
  RoomError,
  RecordingError,
  GenericError,
  TimeoutError,
  ParseError,
  // Union type
  type SDKError,
  // Converters
  toChalkError,
  fromChalkError,
} from "./errors";

// Services
export {
  // Service interfaces
  type TokenServiceInterface,
  type LoggerInterface,
  type EventEmitterInterface,
  // Context Tags
  TokenService,
  TokenProviderService,
  ConfigService,
  LoggerService,
  EventEmitterService,
  // Layers
  NoopLoggerLive,
  ConsoleLoggerLive,
  makeLoggerLayer,
  makeConfigLayer,
  makeTokenProviderLayer,
} from "./services";

// Connection
export {
  type RTKConnectionOptions,
  type WSConnectionOptions,
  connectRealtimeKit,
  joinRTKRoom,
  connectWebSocket,
  makeConnectionReady,
  runScoped,
  makeJoinSemaphore,
  withJoinLock,
  createOperationLock,
  type OperationLock,
} from "./connection";

// Token Service
export {
  makeTokenServiceLive,
  refreshAndRetry,
  createTokenManager,
  type TokenManager,
} from "./token-service";

// WebSocket
export {
  type WSConfig,
  type TypedWSMessage,
  makeReconnectSchedule,
  connectWithRetry,
  makeHeartbeat,
  withHeartbeat,
  refreshTokenForReconnect,
  MessageQueueStrategies,
  processMessageQueue,
  handleWSMessage,
  makeLastPongRef,
  updateLastPong,
} from "./websocket";

// Runtime
export {
  // Types
  type SDKServices,
  type ErrorEmitter,
  type RunSDKEffectOptions,
  // Layer factory
  makeSDKLayer,
  makeSDKRuntime,
  // Runners
  runSDKEffect,
  runSDKEffectEmitOnly,
  // Utilities
  fromPromise,
  withTimeout,
} from "./runtime";

// Schemas - re-export all from schemas module
export * from "./schemas";

// Manager Services
export {
  // Room Instance
  RoomInstanceService,
  RoomInstanceServiceLive,
  getRoom,
  requireRoom,
  setRoom,
  // Room Service
  RoomService,
  RoomServiceLive,
  type RoomServiceInterface,
  type JoinOptions,
  type LeaveOptions,
  // Participant Service
  ParticipantService,
  ParticipantServiceLive,
  type ParticipantServiceInterface,
  // Media Service
  MediaService,
  MediaServiceLive,
  type MediaServiceInterface,
  // Layer composition
  type ManagerServices,
  makeManagerServicesLayer,
  ManagerServicesLive,
  ManagerServicesDebug,
  makeManagerRuntime,
  runManagerEffect,
  getManagerServices,
} from "./services/index";
