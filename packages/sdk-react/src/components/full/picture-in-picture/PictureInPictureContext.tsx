import type React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useRef } from "react";

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

function areEqualValues(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => areEqualValues(value, right[index]));
  }

  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);

    if (leftEntries.length !== rightEntries.length) {
      return false;
    }

    return leftEntries.every(([key, value]) => areEqualValues(value, (right as Record<string, unknown>)[key]));
  }

  return false;
}

function isSameRegistration(
  current: SharedPictureInPictureRegistration | null,
  ownerId: string,
  options: UsePictureInPictureOptions,
) {
  return current?.ownerId === ownerId && areEqualValues(current.options, options);
}

export function SharedPictureInPictureProvider({ enabled = true, children }: { enabled?: boolean; children: React.ReactNode }) {
  const [registration, setRegistration] = useState<SharedPictureInPictureRegistration | null>(null);
  const pendingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pendingClearRef.current) {
        clearTimeout(pendingClearRef.current);
      }
    };
  }, []);

  const register = useCallback((ownerId: string, options: UsePictureInPictureOptions | null) => {
    if (options) {
      if (pendingClearRef.current) {
        clearTimeout(pendingClearRef.current);
        pendingClearRef.current = null;
      }
      setRegistration((current) => {
        if (isSameRegistration(current, ownerId, options)) {
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
