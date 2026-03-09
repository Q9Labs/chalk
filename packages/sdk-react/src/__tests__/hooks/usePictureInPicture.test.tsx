import { afterEach, describe, expect, it, vi } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useEffect, useId } from "react";

import { SharedPictureInPictureProvider, useSharedPictureInPicture } from "../../components/full/picture-in-picture/PictureInPictureContext";
import { usePictureInPicture } from "../../hooks/ui/usePictureInPicture";

const originalDocumentPictureInPicture = window.documentPictureInPicture;
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
