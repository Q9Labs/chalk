import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { trapDialogFocus } from "../../lib/dialog-focus";
import { AppPair } from "./AppLogo";

/** The confirmation for cutting an app off from the account: the broken connection is the picture, the buttons are the only choice. */
export function DisconnectPrompt({ app, onCancel, onConfirm }: { readonly app: string; readonly onCancel: () => void; readonly onConfirm: () => Promise<void> }) {
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const copyId = useId();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.current?.querySelector<HTMLElement>(".btn.gh")?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    trapDialogFocus(event);
  }

  function confirm() {
    setBusy(true);
    onConfirm().finally(() => setBusy(false));
  }

  return (
    <div
      className="scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div ref={card} className="brk" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={copyId} onKeyDown={onKeyDown}>
        <AppPair name={app} broken size="xl" />
        <h2 id={titleId}>Disconnect {app}?</h2>
        <p id={copyId}>{app} loses access to your Chalk account at once. To use it again, approve it again.</p>
        <div className="acts">
          <button type="button" className="btn gh lg" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn dz lg" disabled={busy} aria-busy={busy ? true : undefined} onClick={confirm}>
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      </div>
    </div>
  );
}
