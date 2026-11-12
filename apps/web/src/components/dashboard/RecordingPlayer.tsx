import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";

import { errorMessage } from "../../lib/dashboard/client";
import { clock, duration, sessionDay } from "../../lib/dashboard/format";
import type { RowModel } from "../../lib/dashboard/lists";
import { trapDialogFocus } from "../../lib/dialog-focus";
import { Icon } from "../site/Icon";
import { people } from "./ListParts";
import { DownloadMenu, SessionViewer, usePastSession } from "./SessionViewer";
import { CopyAction, ErrorPanel, Sk } from "./kit";

const sessionLink = (row: RowModel) => `${window.location.origin}/dashboard/call/${row.spaceId}/session/${row.episodeId}`;
const LINK_COPIED = "Link copied. It opens for people signed in to this account.";

/** The recording from the Recordings list, played where it was found, with its transcript beside it. */
export function RecordingPlayer({ row, onClose }: { readonly row: RowModel; readonly onClose: () => void }) {
  const ids = useMemo(() => ({ spaceId: row.spaceId, episodeId: row.episodeId }), [row.spaceId, row.episodeId]);
  const { state, reload, actions } = usePastSession(ids);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  // The close button is replaced when the session arrives, so focus goes to the new one; otherwise Esc would reach the page, not the dialog.
  useEffect(() => {
    if (!card.current?.contains(document.activeElement)) card.current?.querySelector<HTMLElement>(".x")?.focus();
  }, [state.kind]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    trapDialogFocus(event);
  }

  const range = row.endedAt ? `${clock(row.startedAt)} to ${clock(row.endedAt)}` : clock(row.startedAt);
  const length = row.endedAt ? ` · ${duration(row.startedAt, row.endedAt)}` : "";
  const open = (
    <Link className="btn out" to="/dashboard/call/$spaceId/session/$episodeId" params={ids}>
      Open session
      <Icon name="arrowR" size={16} />
    </Link>
  );
  return (
    <div
      className="scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={card} className="dlg plm" role="dialog" aria-modal="true" aria-labelledby="player-title" onKeyDown={onKeyDown}>
        {state.kind === "ready" ? (
          <SessionViewer ids={ids} page={state.data} actions={actions}>
            {({ recording, playable, downloadableTranscript, media, panel }) => (
              <>
                <div className="plh">
                  <div>
                    <h2 id="player-title">{row.callName}</h2>
                    <div className="sub">
                      {sessionDay(row.startedAt)}, {range}
                      {length} · {people(row.people)}
                    </div>
                  </div>
                  <span className="end">
                    {recording && (playable || downloadableTranscript) ? <DownloadMenu ids={ids} recording={recording} video={playable} transcript={downloadableTranscript} /> : null}
                    <CopyAction pill text={sessionLink(row)} toastMessage={LINK_COPIED} />
                    {open}
                    <button type="button" className="ib x" aria-label="Close" onClick={onClose}>
                      <Icon name="x" />
                    </button>
                  </span>
                </div>
                <div className="pbody">
                  <div className="vcol">
                    {media}
                    <div className="pact">
                      {recording && (playable || downloadableTranscript) ? <DownloadMenu ids={ids} recording={recording} video={playable} transcript={downloadableTranscript} /> : <span />}
                      <CopyAction pill text={sessionLink(row)} toastMessage={LINK_COPIED} />
                      {open}
                    </div>
                  </div>
                  <div className="trbox">{panel}</div>
                </div>
              </>
            )}
          </SessionViewer>
        ) : (
          <>
            <div className="plh">
              <div>
                <h2 id="player-title">{row.callName}</h2>
              </div>
              <span className="end">
                {open}
                <button type="button" className="ib x" aria-label="Close" onClick={onClose}>
                  <Icon name="x" />
                </button>
              </span>
            </div>
            <div className="pbody">
              <div className="vcol">{state.kind === "error" ? <ErrorPanel title="Couldn’t load this recording" detail={errorMessage(state.error)} onRetry={reload} /> : <Sk width="100%" height={300} radius="12px" />}</div>
              <div className="trbox" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
