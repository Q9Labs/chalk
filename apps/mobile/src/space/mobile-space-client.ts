import type { GetAccess, SpaceClient } from "@q9labsai/chalk-client";
import { createNativeSpaceClient } from "@q9labsai/chalk-react-native/client";
import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

import type { ParticipantCredential, SpaceRoute } from "../lib/spaces";
import type { EntranceSettings } from "@q9labsai/chalk-react-native";

type MobileSpaceClientOptions = {
  readonly credential: ParticipantCredential;
  readonly defaults: Pick<EntranceSettings, "camera" | "microphone">;
  readonly getAccess: GetAccess;
  readonly journey?: TelemetryJourney;
  readonly space: SpaceRoute["space"];
};

export function createMobileSpaceClient({ credential, defaults, getAccess, journey, space }: MobileSpaceClientOptions): SpaceClient {
  return createNativeSpaceClient({
    baseUrl: credential.apiBaseURL,
    camera: defaults.camera,
    getAccess,
    microphone: defaults.microphone,
    space,
    syncUrl: credential.syncURL,
    telemetry: journey,
  });
}

export type MobileSpaceClientOwner = {
  readonly release: () => Promise<void>;
};

export type MobileSpaceRelease = (credential?: ParticipantCredential) => Promise<void>;

type MobileSpaceReleaseOptions = {
  readonly cleanupCredential: (credential: ParticipantCredential) => Promise<void>;
  readonly onClose: () => Promise<void>;
  readonly onReleaseFailure?: () => void;
  readonly onReleaseStart?: () => void;
};

/** Shares one cleanup/close attempt across leave and Episode-ended callbacks. */
export function createMobileSpaceRelease({ cleanupCredential, onClose, onReleaseFailure, onReleaseStart }: MobileSpaceReleaseOptions): MobileSpaceRelease {
  let releasePromise: Promise<void> | undefined;

  return (credential) => {
    if (releasePromise) return releasePromise;

    onReleaseStart?.();
    let completion: Promise<void>;
    const attempt = (async () => {
      if (credential) await cleanupCredential(credential);
      await onClose();
    })();
    completion = attempt.then(
      () => {
        if (releasePromise === completion) releasePromise = undefined;
      },
      (cause: unknown) => {
        if (releasePromise === completion) {
          releasePromise = undefined;
          onReleaseFailure?.();
        }
        throw cause;
      },
    );
    releasePromise = completion;
    return completion;
  };
}

/** Releases a supplied client exactly once. Chalk only disposes clients it creates itself. */
export function ownMobileSpaceClient(client: SpaceClient): MobileSpaceClientOwner {
  let released = false;

  return {
    async release() {
      if (released) return;
      released = true;

      try {
        if (client.getSnapshot().connection.status !== "left") await client.leave();
      } catch {
        // Disposal must still release device resources after a failed leave.
      } finally {
        client.dispose();
      }
    },
  };
}
