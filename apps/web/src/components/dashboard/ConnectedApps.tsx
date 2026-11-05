import { useState } from "react";

import type { ConnectionDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { ago } from "../../lib/dashboard/format";
import { useLoad } from "./AppShell";
import { Dialog, Sk, useToast } from "./kit";

/** Apps such as Claude and ChatGPT that signed in to this account through OAuth. */
export function ConnectedApps() {
  const { state, update } = useLoad(() => readPage("connections", {}), "connections");
  const [revoking, setRevoking] = useState<ConnectionDTO | null>(null);
  const toast = useToast();

  return (
    <>
      <div className="secth" style={{ marginTop: 48 }}>
        <h2>Connected apps</h2>
      </div>
      {state.kind === "loading" ? <Sk width="100%" height={48} /> : null}
      {state.kind === "error" ? <p className="ohelp">Couldn’t load connected apps. {errorMessage(state.error)}</p> : null}
      {state.kind === "ready" && state.data.connections.length === 0 ? (
        <div className="list">
          <div className="empty">
            <b>No connected apps</b>
            <p>Add Chalk as a custom connector in Claude or ChatGPT and approve it here. It then shows up in this list.</p>
          </div>
        </div>
      ) : null}
      {state.kind === "ready" && state.data.connections.length > 0 ? (
        <div className="list origins">
          {state.data.connections.map((connection) => (
            <div className="orow" key={connection.id}>
              <span>
                <b>{connection.clientName}</b> · {connection.scope === "chalk:manage" ? "Read and change" : "Read only"} · {connection.lastUsedAt ? `Used ${ago(connection.lastUsedAt)}` : "Not used yet"}
              </span>
              <button type="button" className="btn sec" onClick={() => setRevoking(connection)}>
                Disconnect
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {revoking ? (
        <Dialog
          alert
          title={`Disconnect ${revoking.clientName}?`}
          description="It stops working at once and has to be approved again to reconnect."
          onClose={() => setRevoking(null)}
          actions={
            <>
              <button type="button" className="btn gh" onClick={() => setRevoking(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn dz"
                onClick={() =>
                  act("connections", { action: "revoke-connection", connectionId: revoking.id }).then(
                    () => {
                      update((value) => ({ connections: value.connections.filter((item) => item.id !== revoking.id) }));
                      setRevoking(null);
                      toast(`Disconnected ${revoking.clientName}`, { icon: "trash" });
                    },
                    (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
                  )
                }
              >
                Disconnect
              </button>
            </>
          }
        />
      ) : null}
    </>
  );
}
