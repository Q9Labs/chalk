import { useState } from "react";

import type { ConnectionDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { ago, fullDate } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { AppLogo } from "./AppLogo";
import { useLoad } from "./AppShell";
import { DisconnectPrompt } from "./DisconnectPrompt";
import { MoreButton, Sk, useToast } from "./kit";

const ACCESS_LABEL = { "chalk:read": "Read only", "chalk:manage": "Read and change" } as const;

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
            <div className="cempty">
              <span className="cempty-app">
                <AppLogo name="Claude" size="sm" />
                Claude
              </span>
              <span className="cempty-app">
                <AppLogo name="ChatGPT" size="sm" />
                ChatGPT
              </span>
            </div>
          </div>
        </div>
      ) : null}
      {state.kind === "ready" && state.data.connections.length > 0 ? (
        <div className="list">
          <table className="tbl capps">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col" className="wide">
                  Access
                </th>
                <th scope="col" className="wide">
                  Connected
                </th>
                <th scope="col" className="wide">
                  Last used
                </th>
                <th scope="col">
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.data.connections.map((connection) => {
                const lastUsed = connection.lastUsedAt ? ago(connection.lastUsedAt) : "Not used yet";
                return (
                  <tr key={connection.id}>
                    <td>
                      <span className="capp">
                        <AppLogo name={connection.clientName} size="sm" />
                        <span>
                          <span className="nm">{connection.clientName}</span>
                          <span className="csub">
                            {ACCESS_LABEL[connection.scope]} · Connected {fullDate(connection.createdAt)} · {lastUsed}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="wide">{ACCESS_LABEL[connection.scope]}</td>
                    <td className="wide">{fullDate(connection.createdAt)}</td>
                    <td className="wide">{lastUsed}</td>
                    <td className="r act">
                      <button type="button" className="ib cdis" data-tip aria-label={`Disconnect ${connection.clientName}`} onClick={() => setRevoking(connection)}>
                        <Icon name="trash" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {state.kind === "ready" && state.data.nextCursor ? (
        <MoreButton label="Show more apps" cursor={state.data.nextCursor} load={(cursor) => readPage("connections", { cursor })} onLoaded={(page) => update((value) => ({ connections: [...value.connections, ...page.connections], nextCursor: page.nextCursor }))} />
      ) : null}
      {revoking ? (
        <DisconnectPrompt
          app={revoking.clientName}
          onCancel={() => setRevoking(null)}
          onConfirm={() =>
            act("connections", { action: "revoke-connection", connectionId: revoking.id }).then(
              () => {
                update((value) => ({ ...value, connections: value.connections.filter((item) => item.id !== revoking.id) }));
                setRevoking(null);
                toast(`Disconnected ${revoking.clientName}`, { icon: "trash" });
              },
              (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
            )
          }
        />
      ) : null}
    </>
  );
}
