import { readReloadRejoin, type JoinOptions, type ReloadRejoinMarker } from "@q9labsai/chalk-client";
import { readRememberedDevices } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAccount } from "../../lib/account-api";

/** The name and devices a visitor joins with. */
export type WebJoinSettings = Required<Pick<JoinOptions, "displayName" | "microphone" | "camera">> & Pick<JoinOptions, "microphoneDeviceId" | "cameraDeviceId" | "speakerDeviceId">;

const displayNameStorageKey = "chalk.display-name";
const devicesOff = { microphone: false, camera: false };

/** The marker a reload of this Space left behind, when it can still return the visitor to the call. */
function readReloadMarker(routeKey: string | undefined): ReloadRejoinMarker | null {
  if (!routeKey) return null;
  try {
    const marker = readReloadRejoin(globalThis.sessionStorage, routeKey);
    return marker?.arrivalHandle ? marker : null;
  } catch {
    return null; // Storage may be disabled; manual entry remains available.
  }
}

/** A name from the link's `?name=`, else the name this browser joined with last. */
function readSavedName(): string {
  const queryName = new URLSearchParams(globalThis.location?.search ?? "").get("name")?.trim();
  if (queryName) return queryName;
  try {
    return globalThis.localStorage.getItem(displayNameStorageKey)?.trim() ?? "";
  } catch {
    return "";
  }
}

function saveDisplayName(displayName: string): void {
  try {
    globalThis.localStorage.setItem(displayNameStorageKey, displayName);
  } catch {
    /* Joining works with storage disabled. */
  }
}

/**
 * Who is entering the Space and with what. A reload marker returns the visitor as before. Otherwise the name comes from the
 * link, this browser or the signed-in account, until the visitor edits it.
 */
export function useVisitor(routeKey: string | undefined) {
  const [reloadMarker] = useState(() => readReloadMarker(routeKey));
  const [automaticName, setAutomaticName] = useState(readSavedName);
  // A visitor who already chose devices in this browser skips the device step and joins with that choice.
  const [rememberedDevices] = useState(() => readRememberedDevices());
  const [displayName, setDisplayName] = useState(reloadMarker?.displayName ?? automaticName);
  const [chosen, setChosen] = useState<WebJoinSettings | null>(reloadMarker ? { displayName: reloadMarker.displayName, ...devicesOff } : null);
  const nameEdited = useRef(false);
  useEffect(() => {
    if (automaticName || reloadMarker) return;
    let cancelled = false;
    void getAccount()
      .then((account) => {
        if (cancelled || nameEdited.current || !account.name.trim()) return;
        setDisplayName((current) => current || account.name);
        setAutomaticName(account.name);
      })
      .catch(() => undefined); // Anonymous visitors supply their own name.
    return () => {
      cancelled = true;
    };
  }, [automaticName, reloadMarker]);
  const editName = useCallback((name: string) => {
    nameEdited.current = true;
    setDisplayName(name);
  }, []);
  /** Keeps the settings a Join used, so Rejoin and the call reuse them. */
  const choose = useCallback((settings: WebJoinSettings) => {
    setDisplayName(settings.displayName);
    setChosen(settings);
    saveDisplayName(settings.displayName);
  }, []);
  const joinSettings = useMemo<WebJoinSettings>(() => ({ ...(chosen ?? devicesOff), displayName }), [displayName, chosen]);
  return { reloadMarker, automaticName, rememberedDevices, displayName, editName, choose, joinSettings, callSettings: chosen ?? joinSettings };
}

export type Visitor = ReturnType<typeof useVisitor>;
