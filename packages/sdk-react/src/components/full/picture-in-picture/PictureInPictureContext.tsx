import type React from "react";
import { createContext, useCallback, useContext, useMemo, useState, useRef } from "react";

import { usePictureInPicture, type UsePictureInPictureOptions } from "../../../hooks/ui/usePictureInPicture";
import type { PictureInPictureControls } from "./types";

interface SharedPictureInPictureRegistration {
  ownerId: string;
  options: UsePictureInPictureOptions;
}

interface SharedPictureInPictureValue {
  isSupported: boolean;
  isActive: boolean;
  phase: UsePictureInPictureOptions["phase"];
  open: () => Promise<void>;
  close: () => Promise<void>;
  toggle: () => Promise<void>;
  register: (ownerId: string, options: UsePictureInPictureOptions | null) => void;
}

const EMPTY_CONTROLS: PictureInPictureControls = {};

const SharedPictureInPictureContext = createContext<SharedPictureInPictureValue | null>(null);

export function SharedPictureInPictureProvider({ enabled = true, children }: { enabled?: boolean; children: React.ReactNode }) {
  const [registration, setRegistration] = useState<SharedPictureInPictureRegistration | null>(null);
  const pendingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const register = useCallback((ownerId: string, options: UsePictureInPictureOptions | null) => {
    if (options) {
      if (pendingClearRef.current) {
        clearTimeout(pendingClearRef.current);
        pendingClearRef.current = null;
      }
      setRegistration((current) => {
        if (current?.ownerId === ownerId && current.options === options) {
          return current;
        }

        return { ownerId, options };
      });
    } else {
      // Small delay to allow for handover between components (e.g. prejoin -> meeting)
      // This prevents the PiP window from closing and losing user activation if a new
      // component registers immediately after.
      pendingClearRef.current = setTimeout(() => {
        setRegistration((current) => (current?.ownerId === ownerId ? null : current));
        pendingClearRef.current = null;
      }, 100);
    }
  }, []);

  const pictureInPicture = usePictureInPicture({
    enabled: enabled && Boolean(registration),
    autoOpen: registration?.options.autoOpen ?? false,
    phase: registration?.options.phase ?? "meeting",
    roomName: registration?.options.roomName,
    displayName: registration?.options.displayName,
    source: registration?.options.source ?? null,
    previewSource: registration?.options.previewSource,
    participantSources: registration?.options.participantSources,
    meetingLayout: registration?.options.meetingLayout,
    controls: registration?.options.controls ?? EMPTY_CONTROLS,
  });

  const value = useMemo<SharedPictureInPictureValue>(
    () => ({
      ...pictureInPicture,
      register,
    }),
    [pictureInPicture, register],
  );

  return <SharedPictureInPictureContext.Provider value={value}>{children}</SharedPictureInPictureContext.Provider>;
}

export function useSharedPictureInPicture() {
  return useContext(SharedPictureInPictureContext);
}
