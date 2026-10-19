import { Chalk } from "@q9labsai/chalk-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RecentCall } from "../home/recent-calls";
import type { ArrivedCall } from "../join/JoiningScreen";
import { cleanupSpaceArrival, createGuestAccessGetter } from "../lib/spaces";
import type { StoredCallPreferences } from "../preferences/call-preferences";
import { createMobileSpaceClient, ownMobileSpaceClient } from "../space/mobile-space-client";
import { ReadySheet } from "./ReadySheet";

type CallScreenProps = {
  readonly apiBaseURL: string;
  readonly call: ArrivedCall;
  readonly preferences: StoredCallPreferences;
  readonly onRemember: (call: RecentCall) => void;
  readonly onClose: () => void;
  readonly onError: (cause: unknown) => void;
};

/** The call itself is `Chalk`. The app adds the link sheet after Start a call and keeps the call in recent calls. */
export function CallScreen({ apiBaseURL, call, preferences, onRemember, onClose, onError }: CallScreenProps): React.JSX.Element {
  const { arrival, route } = call;
  const [readyOpen, setReadyOpen] = useState(false);
  const client = useMemo(() => {
    const getAccess = createGuestAccessGetter({ apiBaseURL, credential: arrival.credential, initialAccess: arrival.access });
    return createMobileSpaceClient({ apiBaseURL, defaults: arrival.defaults, getAccess, space: route.space });
  }, [apiBaseURL, arrival, route.space]);

  useEffect(() => {
    const owner = ownMobileSpaceClient(client);
    return () => void owner.release();
  }, [client]);

  // Others seen in the call, in the order they were first seen; the newest three become the row's faces.
  const people = useRef<string[]>([]);
  const remember = useRef<() => void>(() => undefined);
  remember.current = () => onRemember({ link: route.inviteLink, name: arrival.spaceName, joinedAt: Date.now(), people: people.current.slice(-3).reverse() });

  useEffect(() => {
    let joined = false;
    const observe = () => {
      const snapshot = client.getSnapshot();
      for (const participant of snapshot.participants.roster) {
        if (participant.participantId !== snapshot.self.participantId && !people.current.includes(participant.displayName)) people.current.push(participant.displayName);
      }
      if (joined || snapshot.connection.status !== "live") return;
      joined = true;
      remember.current();
      if (call.started) setReadyOpen(true);
    };
    observe();
    return client.subscribe(observe);
  }, [call.started, client]);

  return (
    <>
      <Chalk
        callName={arrival.spaceName}
        client={client}
        colorScheme={preferences.colorScheme}
        displayName={arrival.displayName}
        inviteLink={route.inviteLink}
        onColorSchemeChange={preferences.setColorScheme}
        onLeave={() => {
          remember.current();
          // Home comes back at once; giving the arrival back finishes, or fails, on its own.
          cleanupSpaceArrival({ apiBaseURL, credential: arrival.credential }).catch(onError);
          onClose();
        }}
        onSoundsEnabledChange={preferences.setSoundsEnabled}
        soundsEnabled={preferences.soundsEnabled}
      />
      <ReadySheet link={route.inviteLink} onClose={() => setReadyOpen(false)} open={readyOpen} />
    </>
  );
}
