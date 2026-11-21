import type { ScreenAnnotationClient } from "@q9labsai/chalk-client";
import { useEffect } from "react";

const penIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%236255ef'/%3E%3Cpath d='m9 23 1-5L21 7l4 4-11 11z' fill='%23fff'/%3E%3C/svg%3E";
const quietMs = 1400;

export function AnnotationTabCue({ client, publicationId, sharerId }: { readonly client: ScreenAnnotationClient; readonly publicationId: string; readonly sharerId: string }): null {
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] Set a tab cue only during active remote drawing; restore the host tab on idle, pagehide or teardown.
  useEffect(() => {
    let originalTitle = "";
    let cueTitle = "";
    let icon: HTMLLinkElement | undefined;
    let changedAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restore = () => {
      clearTimeout(timer);
      if (cueTitle && document.title === cueTitle) document.title = originalTitle;
      cueTitle = "";
      icon?.remove();
      icon = undefined;
    };
    const update = () => {
      const snapshot = client.getSnapshot();
      if (snapshot.status !== "ready" || snapshot.state?.layer.publication_id !== publicationId || snapshot.state.paused) {
        restore();
        return;
      }
      const now = client.serverNowMs();
      const active = snapshot.presence.find((peer) => peer.author.participant_id !== sharerId && peer.expires_at_ms > now && (peer.draft || peer.cursor?.tool === "pointer"));
      if (!active) return;
      if (!cueTitle || now - changedAt >= quietMs) {
        if (document.title !== cueTitle) originalTitle = document.title;
        const name = active.author.display_name.slice(0, 80);
        cueTitle = `✎ ${name} is drawing · ${originalTitle}`;
        document.title = cueTitle;
        changedAt = now;
        if (!icon) {
          icon = document.createElement("link");
          icon.rel = "icon";
          icon.href = penIcon;
          document.head.appendChild(icon);
        }
      }
      clearTimeout(timer);
      timer = setTimeout(restore, quietMs);
    };
    const unsubscribe = client.subscribe(update);
    window.addEventListener("pagehide", restore);
    update();
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", restore);
      restore();
    };
  }, [client, publicationId, sharerId]);
  return null;
}
