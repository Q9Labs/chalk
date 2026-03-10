import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { fireEvent, render } from "@testing-library/react";

const createParticipantsState = () => ({
  localParticipant: { id: "local", role: "host" as const },
});

const createScreenShareState = () => ({
  isActive: true,
  isStarting: false,
  isLocalSharing: true,
  sharerParticipantId: "local",
  videoTrack: null,
  audioTrack: null,
  start: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
});

const createAnnotationsState = () => ({
  accessMode: "all" as const,
  canDraw: false,
  clear: vi.fn(),
  close: vi.fn(),
  cursors: [],
  isOpen: false,
  isSessionActive: false,
  items: [],
  lastSeq: 0,
  open: vi.fn(),
  replaceItems: vi.fn(),
  requestSync: vi.fn(),
  sendCursor: vi.fn(),
  setAccessMode: vi.fn(),
  shareSessionId: null,
  sharerParticipantId: null,
  startSession: vi.fn(),
  toggle: vi.fn(),
});

let participantsState = createParticipantsState();
let screenShareState = createScreenShareState();
let annotationsState = createAnnotationsState();
const sessionState = {
  recordIncidentBreadcrumb: vi.fn(),
};

vi.mock("../../context/chalk-provider", () => ({
  useSession: () => sessionState,
}));

vi.mock("../../hooks/participants/useParticipants", () => ({
  useParticipants: () => participantsState,
}));

vi.mock("../../hooks/stream/useScreenShare", () => ({
  useScreenShare: () => screenShareState,
}));

vi.mock("../../hooks/features/useScreenAnnotations", () => ({
  useScreenAnnotations: () => annotationsState,
}));

import { ScreenAnnotationsLayer } from "../../components/composite/screen-annotations/ScreenAnnotationsLayer";

describe("ScreenAnnotationsLayer", () => {
  beforeEach(() => {
    participantsState = createParticipantsState();
    screenShareState = createScreenShareState();
    annotationsState = createAnnotationsState();
    sessionState.recordIncidentBreadcrumb.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts the local annotation session immediately when the sharer opens the toolbar", () => {
    const { getByText } = render(<ScreenAnnotationsLayer enabled />);

    fireEvent.click(getByText("Annotate Screen"));

    expect(annotationsState.startSession).toHaveBeenCalledTimes(1);
    expect(annotationsState.requestSync).not.toHaveBeenCalled();
    expect(annotationsState.open).toHaveBeenCalledTimes(1);
    expect(sessionState.recordIncidentBreadcrumb).toHaveBeenCalled();
  });

  it("starts the local annotation session when the active share owner matches local participant even if isLocalSharing drifted false", () => {
    screenShareState = {
      ...screenShareState,
      isLocalSharing: false,
      sharerParticipantId: "local",
    };

    const { getByText } = render(<ScreenAnnotationsLayer enabled />);

    fireEvent.click(getByText("Annotate Screen"));

    expect(annotationsState.startSession).toHaveBeenCalledTimes(1);
    expect(annotationsState.requestSync).not.toHaveBeenCalled();
    expect(annotationsState.open).toHaveBeenCalledTimes(1);
  });

  it("does not request sync while the local sharer already owns the active session", () => {
    annotationsState = {
      ...annotationsState,
      canDraw: true,
      isOpen: true,
      isSessionActive: true,
      shareSessionId: "share-1",
      sharerParticipantId: "local",
    };

    render(<ScreenAnnotationsLayer enabled />);

    expect(annotationsState.requestSync).not.toHaveBeenCalled();
    expect(sessionState.recordIncidentBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "annotations_ui",
        message: "Annotation sync skipped for local owner",
      }),
    );
  });
});
