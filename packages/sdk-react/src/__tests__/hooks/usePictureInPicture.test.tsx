import { afterEach, describe, expect, it, vi } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useEffect, useId } from "react";

import { SharedPictureInPictureProvider, useSharedPictureInPicture } from "../../components/full/picture-in-picture/PictureInPictureContext";
import { usePictureInPicture } from "../../hooks/ui/usePictureInPicture";

const originalDocumentPictureInPicture = window.documentPictureInPicture;
const originalUserActivationDescriptor = Object.getOwnPropertyDescriptor(navigator, "userActivation");
const PREJOIN_SOURCE = {
  id: "prejoin",
  kind: "participant" as const,
  title: "Hasan",
  isLocal: true as const,
  videoTrack: null,
};
const MEETING_SOURCE = {
  id: "meeting",
  kind: "participant" as const,
  title: "Hasan",
  subtitle: "Live",
  isLocal: true as const,
  videoTrack: null,
};

function Harness() {
  const pip = usePictureInPicture({
    enabled: true,
    phase: "meeting",
    roomName: "PiP Room",
    displayName: "Hasan",
    source: {
      id: "local",
      kind: "participant",
      title: "Hasan",
      videoTrack: null,
      isLocal: true,
    },
    controls: {},
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void pip.open();
        }}
      >
        open
      </button>
      <button
        type="button"
        onClick={() => {
          void pip.close();
        }}
      >
        close
      </button>
      <span>{pip.isSupported ? "supported" : "unsupported"}</span>
      <span>{pip.isActive ? "active" : "inactive"}</span>
    </div>
  );
}

function AutoOpenHarness() {
  const pip = usePictureInPicture({
    enabled: true,
    autoOpen: true,
    phase: "meeting",
    roomName: "PiP Room",
    displayName: "Hasan",
    source: {
      id: "local",
      kind: "participant",
      title: "Hasan",
      videoTrack: null,
      isLocal: true,
    },
    controls: {},
  });

  return (
    <div>
      <span>{pip.isSupported ? "supported" : "unsupported"}</span>
      <span>{pip.isActive ? "active" : "inactive"}</span>
    </div>
  );
}

function mockUserActivation(isActive: boolean) {
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    get: () => ({
      isActive,
    }),
  });
}

function SharedPhaseHarness({ phase }: { phase: "prejoin" | "meeting" }) {
  return <SharedPictureInPictureProvider enabled>{phase === "prejoin" ? <PreJoinRegistrar /> : <MeetingRegistrar />}</SharedPictureInPictureProvider>;
}

function PreJoinRegistrar() {
  return <SharedRegistrar phase="prejoin" source={PREJOIN_SOURCE} />;
}

function MeetingRegistrar() {
  return <SharedRegistrar phase="meeting" source={MEETING_SOURCE} />;
}

function SharedRegistrar({
  phase,
  source,
}: {
  phase: "prejoin" | "meeting";
  source: {
    id: string;
    kind: "participant";
    title: string;
    subtitle?: string;
    isLocal: true;
    videoTrack: null;
  };
}) {
  const pip = useSharedPictureInPicture();
  const registerPictureInPicture = pip?.register;
  const ownerId = useId();

  useEffect(() => {
    registerPictureInPicture?.(ownerId, {
      phase,
      roomName: "PiP Room",
      displayName: "Hasan",
      source,
      controls: {},
    });

    return () => {
      registerPictureInPicture?.(ownerId, null);
    };
  }, [ownerId, phase, registerPictureInPicture, source]);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void pip?.open();
        }}
      >
        open shared
      </button>
      <span>{pip?.phase ?? "none"}</span>
      <span>{pip?.isActive ? "shared-active" : "shared-inactive"}</span>
    </div>
  );
}

describe("usePictureInPicture", () => {
  afterEach(() => {
    window.documentPictureInPicture = originalDocumentPictureInPicture;

    if (originalUserActivationDescriptor) {
      Object.defineProperty(navigator, "userActivation", originalUserActivationDescriptor);
    } else {
      // @ts-expect-error test cleanup for optional browser API
      delete navigator.userActivation;
    }
  });

  it("opens and closes a Document PiP window", async () => {
    const pipDocument = document.implementation.createHTMLDocument("pip");
    const close = vi.fn();

    window.documentPictureInPicture = {
      requestWindow: vi.fn().mockResolvedValue({
        document: pipDocument,
        addEventListener: vi.fn(),
        close,
        focus: vi.fn(),
        closed: false,
      }),
    } as any;

    const { getByText } = render(<Harness />);
    expect(getByText("supported")).toBeDefined();

    fireEvent.click(getByText("open"));

    await waitFor(() => {
      expect(getByText("active")).toBeDefined();
    });

    fireEvent.click(getByText("close"));

    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
      expect(getByText("inactive")).toBeDefined();
    });
  });

  it("auto-opens when mounted with user activation", async () => {
    const pipDocument = document.implementation.createHTMLDocument("pip");
    const requestWindow = vi.fn().mockResolvedValue({
      document: pipDocument,
      addEventListener: vi.fn(),
      close: vi.fn(),
      focus: vi.fn(),
      closed: false,
    });

    mockUserActivation(true);
    window.documentPictureInPicture = {
      requestWindow,
    } as any;

    const { getByText } = render(<AutoOpenHarness />);

    await waitFor(() => {
      expect(requestWindow).toHaveBeenCalledTimes(1);
      expect(getByText("active")).toBeDefined();
    });
  });

  it("auto-opens on the next eligible user interaction when mount-time activation is unavailable", async () => {
    const pipDocument = document.implementation.createHTMLDocument("pip");
    const requestWindow = vi.fn().mockResolvedValue({
      document: pipDocument,
      addEventListener: vi.fn(),
      close: vi.fn(),
      focus: vi.fn(),
      closed: false,
    });

    mockUserActivation(false);
    window.documentPictureInPicture = {
      requestWindow,
    } as any;

    const { getByText } = render(<AutoOpenHarness />);

    await waitFor(() => {
      expect(getByText("inactive")).toBeDefined();
    });
    expect(requestWindow).toHaveBeenCalledTimes(0);

    mockUserActivation(true);
    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(requestWindow).toHaveBeenCalledTimes(1);
      expect(getByText("active")).toBeDefined();
    });
  });

  it("keeps the same Document PiP window across phase transitions", async () => {
    const pipDocument = document.implementation.createHTMLDocument("pip");
    const requestWindow = vi.fn().mockResolvedValue({
      document: pipDocument,
      addEventListener: vi.fn(),
      close: vi.fn(),
      focus: vi.fn(),
      closed: false,
    });

    window.documentPictureInPicture = {
      requestWindow,
    } as any;

    const { getByText, rerender } = render(<SharedPhaseHarness phase="prejoin" />);

    fireEvent.click(getByText("open shared"));

    await waitFor(() => {
      expect(getByText("prejoin")).toBeDefined();
      expect(getByText("shared-active")).toBeDefined();
    });

    rerender(<SharedPhaseHarness phase="meeting" />);

    await waitFor(() => {
      expect(getByText("meeting")).toBeDefined();
      expect(getByText("shared-active")).toBeDefined();
      expect(requestWindow).toHaveBeenCalledTimes(1);
    });
  });
});
