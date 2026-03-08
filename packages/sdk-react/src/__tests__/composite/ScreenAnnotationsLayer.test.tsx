import { describe, expect, it, vi } from "bun:test";
import { render } from "@testing-library/react";
import { ScreenAnnotationsLayer } from "../../components/composite/screen-annotations/ScreenAnnotationsLayer";

const requestSync = vi.fn();
const startSession = vi.fn();
const noop = vi.fn();
const items: [] = [];
const cursors: [] = [];
const annotationsState = {
  accessMode: "all" as const,
  canDraw: true,
  clear: noop,
  close: noop,
  cursors,
  isOpen: true,
  isSessionActive: true,
  items,
  open: noop,
  sharerParticipantId: "local-participant",
  startSession,
  replaceItems: noop,
  requestSync,
  sendCursor: noop,
  setAccessMode: noop,
};

vi.mock("../../hooks/participants/useParticipants", () => ({
  useParticipants: () => ({
    localParticipant: {
      id: "local-participant",
      role: "host",
    },
  }),
}));

vi.mock("../../hooks/stream/useScreenShare", () => ({
  useScreenShare: () => ({
    isActive: true,
    isLocalSharing: true,
  }),
}));

vi.mock("../../hooks/features/useScreenAnnotations", () => ({
  useScreenAnnotations: () => annotationsState,
}));

vi.mock("../../components/composite/screen-annotations/ScreenAnnotationsSvg", () => ({
  ScreenAnnotationsSvg: () => <div data-testid="annotations-svg" />,
}));

vi.mock("../../components/composite/screen-annotations/ScreenAnnotationsToolbar", () => ({
  ScreenAnnotationsToolbar: () => <div data-testid="annotations-toolbar" />,
}));

describe("ScreenAnnotationsLayer", () => {
  it("does not request sync for an already-active local annotation session", () => {
    requestSync.mockClear();
    startSession.mockClear();
    render(<ScreenAnnotationsLayer enabled={true} />);

    expect(requestSync).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });
});
