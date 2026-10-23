import { useEffect, useState } from "react";
import { ChalkProvider, ToastStack, type Toast } from "@q9labsai/chalk-react";
import { SpaceView } from "../../../../sdks/typescript/react/src/components/space-view/SpaceView";
import { createCallStateClient, liveSnapshot } from "./fixtures";
import { SpacePresentation } from "../../../../sdks/typescript/react/src/components/space-view/SpacePresentation";
import { SpaceStage } from "../../../../sdks/typescript/react/src/components/stage/SpaceStage";
import { NoticeButton } from "../../../../sdks/typescript/react/src/components/toast-stack/NoticeButton";

export function OfflineNoticeFixture() {
  const [client] = useState(() => {
    const snapshot = liveSnapshot();
    return createCallStateClient({ ...snapshot, offline: { ...snapshot.offline, notice: "Your expired offline actions were not sent. Actions are kept for up to 24 hours." } });
  });
  useEffect(() => () => client.dispose(), [client]);
  return (
    <ChalkProvider client={client}>
      <div className="h-dvh">
        <SpaceView spaceName="Team" callLinkOpen={false} features={{ sounds: false }} generatedAvatars={false} commandError="Camera blocked" whiteboard={{ isOpen: true, props: { canDraw: true, theme: "dark" } }} />
      </div>
    </ChalkProvider>
  );
}

/** SDK-sized notice stacks, including content longer than the call's available band. */
export function NoticeBandFixture() {
  const [client] = useState(() => createCallStateClient(liveSnapshot()));
  useEffect(() => () => client.dispose(), [client]);
  const params = new URLSearchParams(location.search);
  const long = params.has("long");
  const fitWidth = params.has("fitWidth");
  const [toasts, setToasts] = useState<readonly Toast[]>(() =>
    Array.from({ length: long || fitWidth ? 1 : 10 }, (_, index) => ({
      id: String(index),
      message: fitWidth ? "Camera permission needs attention. Check your browser settings before trying again. ".repeat(4) : long ? "Camera permission needs attention. ".repeat(100) : `Camera ${index + 1} could not start. Check its permissions and try again.`,
      type: "error",
      duration: Infinity,
    })),
  );
  const [folded, setFolded] = useState<readonly string[]>([]);
  const dismiss = (id: string) => setToasts((current) => current.filter((toast) => toast.id !== id));
  return (
    <ChalkProvider client={client}>
      <div className="h-dvh">
        <SpacePresentation
          stageBackground
          header={{ spaceName: "Team", notices: <NoticeButton toasts={toasts.filter((toast) => folded.includes(toast.id))} onDismiss={dismiss} /> }}
          stage={<SpaceStage tiles={[]} layout="focus" whiteboard={{ isOpen: true, props: { canDraw: true, theme: "dark" } }} />}
          controls={<button type="button">Call controls</button>}
          toasts={<ToastStack toasts={toasts} maxVisible={long ? 3 : 10} onDismiss={dismiss} onFold={setFolded} />}
        />
      </div>
    </ChalkProvider>
  );
}
