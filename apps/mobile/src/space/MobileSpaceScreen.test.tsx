import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  stateValues: [] as unknown[],
}));
const mocks = vi.hoisted(() => {
  const journey = { headers: { traceparent: "00-mobile" }, phase: vi.fn(), terminal: vi.fn() };
  const telemetry = { dispose: vi.fn(), flush: vi.fn(async () => undefined), startJourney: vi.fn(() => journey) };
  const getAccess = vi.fn();
  const client = { dispose: vi.fn(), getSnapshot: vi.fn(() => ({ connection: { status: "idle", lastError: null } })), leave: vi.fn(async () => undefined), subscribe: vi.fn(() => () => undefined) };
  const credential = {
    apiBaseURL: "https://api.chalk.test",
    participantCredentialId: "c".repeat(43),
    spaceInviteToken: "i".repeat(43),
    syncURL: "wss://sync.chalk.test/v1/sync",
  };
  return {
    Chalk: vi.fn(() => null),
    Entrance: vi.fn(() => null),
    MOBILE_SPACE_FEATURES: { participants: true, whiteboard: true },
    cleanupParticipantCredential: vi.fn(async () => undefined),
    client,
    createAccessGrantGetter: vi.fn(() => getAccess),
    createMobileSpaceClient: vi.fn(() => client),
    createMobileSpaceRelease: vi.fn(() => vi.fn(async () => undefined)),
    createMobileTelemetry: vi.fn(() => telemetry),
    credential,
    flushAndDisposeTelemetry: vi.fn(async () => undefined),
    getAccess,
    journey,
    ownMobileSpaceClient: vi.fn(() => ({ release: vi.fn(async () => undefined) })),
    prepareParticipantCredential: vi.fn(async () => credential),
    recordMobileSpaceJoined: vi.fn(),
    spaceInviteLink: vi.fn((token: string) => `https://chalkmeet.com/space#spaceInviteToken=${token}`),
    telemetry,
    terminalizeMobileSpaceJourney: vi.fn(),
  };
});

vi.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(initial: T): readonly [T, ReturnType<typeof vi.fn>] => {
    const value = (hooks.stateValues.shift() as T | undefined) ?? initial;
    const setter = vi.fn();
    hooks.setters.push(setter);
    return [value, setter];
  },
}));
vi.mock("@q9labsai/chalk-react-native", () => ({ Chalk: mocks.Chalk, Entrance: mocks.Entrance }));
vi.mock("@q9labsai/chalk-client", () => ({}));
vi.mock("expo-constants", () => ({ default: { nativeAppVersion: "2.0.0", nativeBuildVersion: "28", expoConfig: { version: "2.0.0" } } }));
vi.mock("../lib/chat-files", () => ({ pickMobileChatFiles: vi.fn() }));
vi.mock("../lib/spaces", () => ({
  cleanupParticipantCredential: mocks.cleanupParticipantCredential,
  createAccessGrantGetter: mocks.createAccessGrantGetter,
  prepareParticipantCredential: mocks.prepareParticipantCredential,
  spaceInviteLink: mocks.spaceInviteLink,
}));
vi.mock("../lib/telemetry", () => ({ createMobileTelemetry: mocks.createMobileTelemetry, flushAndDisposeTelemetry: mocks.flushAndDisposeTelemetry }));
vi.mock("./mobile-space-features", () => ({ MOBILE_SPACE_FEATURES: mocks.MOBILE_SPACE_FEATURES }));
vi.mock("./mobile-space-client", () => ({ createMobileSpaceClient: mocks.createMobileSpaceClient, createMobileSpaceRelease: mocks.createMobileSpaceRelease, ownMobileSpaceClient: mocks.ownMobileSpaceClient }));
vi.mock("./mobile-space-telemetry-lifecycle", () => ({ recordMobileSpaceJoined: mocks.recordMobileSpaceJoined, terminalizeMobileSpaceJourney: mocks.terminalizeMobileSpaceJourney }));

import { MobileSpaceScreen } from "./MobileSpaceScreen";

const route = {
  kind: "space" as const,
  space: "local-space" as const,
  spaceInviteToken: "i".repeat(43),
  spaceName: "Daily Space",
  source: "space-link" as const,
};

beforeEach(() => {
  hooks.cleanups.length = 0;
  hooks.setters.length = 0;
  hooks.stateValues.length = 0;
  mocks.createMobileTelemetry.mockClear();
  mocks.telemetry.flush.mockClear();
  mocks.telemetry.startJourney.mockClear();
  mocks.journey.phase.mockClear();
  mocks.journey.terminal.mockClear();
  mocks.prepareParticipantCredential.mockClear().mockResolvedValue(mocks.credential);
  mocks.createAccessGrantGetter.mockClear().mockReturnValue(mocks.getAccess);
  mocks.createMobileSpaceClient.mockClear().mockReturnValue(mocks.client);
  mocks.createMobileSpaceRelease.mockClear().mockReturnValue(vi.fn(async () => undefined));
  mocks.ownMobileSpaceClient.mockClear().mockReturnValue({ release: vi.fn(async () => undefined) });
  mocks.recordMobileSpaceJoined.mockClear();
  mocks.terminalizeMobileSpaceJourney.mockClear();
  mocks.spaceInviteLink.mockClear();
  mocks.client.getSnapshot.mockClear().mockReturnValue({ connection: { status: "idle", lastError: null } });
  mocks.client.subscribe.mockClear().mockReturnValue(() => undefined);
});

describe("MobileSpaceScreen", () => {
  it("prepares a Participant credential from Entrance settings before creating the SpaceClient", async () => {
    const rendered = MobileSpaceScreen({ brokerUrl: "https://broker.chalk.test", onClose: vi.fn(async () => undefined), onDiagnosticsFailure: vi.fn(), route, telemetryEnabled: true }) as unknown as ElementLike;

    expect(rendered.type).toBe(mocks.Entrance);
    expect(rendered.props).toMatchObject({ defaults: { camera: true, microphone: true }, joining: false, spaceName: route.spaceName });

    await (rendered.props.onJoin as (settings: { readonly camera: boolean; readonly displayName: string; readonly microphone: boolean }) => Promise<void>)({ camera: false, displayName: " Ada ", microphone: true });

    expect(mocks.prepareParticipantCredential).toHaveBeenCalledWith({
      brokerUrl: "https://broker.chalk.test",
      displayName: " Ada ",
      headers: mocks.journey.headers,
      spaceInviteToken: route.spaceInviteToken,
    });
    expect(mocks.createMobileSpaceClient).not.toHaveBeenCalled();
    expect(hooks.setters[0]).toHaveBeenCalledWith(expect.objectContaining({ credential: mocks.credential, displayName: " Ada " }));
    expect(mocks.telemetry.flush).toHaveBeenCalledOnce();
  });

  it("passes the prepared arrival to Chalk and shares lifecycle callbacks through one release", () => {
    const arrival = { credential: mocks.credential, defaults: { camera: false, microphone: true }, displayName: "Ada", journey: mocks.journey };
    hooks.stateValues.push(arrival, undefined, false);

    const rendered = MobileSpaceScreen({ brokerUrl: "https://broker.chalk.test", onClose: vi.fn(async () => undefined), route, telemetryEnabled: false }) as unknown as ElementLike;

    expect(rendered.type).toBe(mocks.Chalk);
    expect(rendered.props).toMatchObject({
      client: mocks.client,
      defaults: arrival.defaults,
      displayName: arrival.displayName,
      entrance: false,
      features: mocks.MOBILE_SPACE_FEATURES,
      inviteLink: `https://chalkmeet.com/space#spaceInviteToken=${mocks.credential.spaceInviteToken}`,
      spaceName: route.spaceName,
      feedbackEvidence: { app: { name: "Chalk", version: "2.0.0", build: "28" } },
    });
    expect(rendered.props.pickChatFiles).toEqual(expect.any(Function));
    expect(mocks.createMobileSpaceClient).toHaveBeenCalledWith({ credential: mocks.credential, defaults: arrival.defaults, getAccess: mocks.getAccess, journey: mocks.journey, space: route.space });

    (rendered.props.onJoined as () => void)();
    (rendered.props.onEpisodeEnded as () => void)();
    (rendered.props.onLeft as () => void)();

    expect(mocks.recordMobileSpaceJoined).toHaveBeenCalledWith(mocks.journey);
    expect(mocks.terminalizeMobileSpaceJourney).toHaveBeenCalledWith(mocks.journey, "episode_ended");
    expect(mocks.createMobileSpaceRelease.mock.results[0]?.value).toHaveBeenCalledWith(mocks.credential);
  });

  it("exports only SDK-provided authenticated headers and clears them", () => {
    const arrival = { credential: mocks.credential, defaults: { camera: false, microphone: true }, displayName: "Ada", journey: mocks.journey };
    hooks.stateValues.push(arrival, undefined, false);
    MobileSpaceScreen({ brokerUrl: "https://broker.chalk.test", onClose: vi.fn(async () => undefined), route, telemetryEnabled: true });

    const telemetryOptions = (mocks.createMobileTelemetry.mock.calls as unknown as Array<[{ readonly getAuthenticatedTelemetryHeaders: () => Readonly<Record<string, string>> | undefined }]>)[0]?.[0];
    if (!telemetryOptions) throw new Error("Mobile telemetry options missing");
    const setAuthenticatedTelemetryHeaders = (mocks.journey as typeof mocks.journey & { setAuthenticatedTelemetryHeaders?: (headers: Readonly<Record<string, string>> | undefined) => void }).setAuthenticatedTelemetryHeaders;
    if (!setAuthenticatedTelemetryHeaders) throw new Error("Authenticated telemetry bridge missing");

    expect(telemetryOptions.getAuthenticatedTelemetryHeaders()).toBeUndefined();
    setAuthenticatedTelemetryHeaders({ Authorization: "Bearer sdk-produced-token" });
    expect(telemetryOptions.getAuthenticatedTelemetryHeaders()).toEqual({ Authorization: "Bearer sdk-produced-token" });
    setAuthenticatedTelemetryHeaders(undefined);
    expect(telemetryOptions.getAuthenticatedTelemetryHeaders()).toBeUndefined();
  });

  it("publishes live and recovering connection snapshots, then clears them on cleanup", () => {
    const arrival = { credential: mocks.credential, defaults: { camera: false, microphone: true }, displayName: "Ada", journey: mocks.journey };
    hooks.stateValues.push(arrival, undefined, false);
    const onDiagnosticsConnection = vi.fn();
    MobileSpaceScreen({ brokerUrl: "https://broker.chalk.test", onClose: vi.fn(async () => undefined), onDiagnosticsConnection, route, telemetryEnabled: false });

    expect(onDiagnosticsConnection).toHaveBeenCalledWith({ status: "idle", lastError: null });
    const publish = (mocks.client.subscribe.mock.calls as unknown as Array<[() => void]>)[0]?.[0];
    if (!publish) throw new Error("SpaceClient diagnostics subscription missing");
    mocks.client.getSnapshot.mockReturnValue({ connection: { status: "reconnecting", lastError: null } });
    publish();
    expect(onDiagnosticsConnection).toHaveBeenLastCalledWith({ status: "reconnecting", lastError: null });

    for (const cleanup of hooks.cleanups) cleanup();
    expect(onDiagnosticsConnection).toHaveBeenLastCalledWith(null);
  });
});

type ElementLike = { readonly type: unknown; readonly props: Record<string, unknown> };
