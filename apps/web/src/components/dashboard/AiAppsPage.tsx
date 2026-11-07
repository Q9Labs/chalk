import { useState } from "react";

import type { ConnectionDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { ago, fullDate } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { AppLogo } from "./AppLogo";
import { useLoad } from "./AppShell";
import { DisconnectPrompt } from "./DisconnectPrompt";
import { CopyAction, ErrorPanel, MoreButton, Sk, useToast } from "./kit";
import { McpClients } from "./McpClients";

const ACCESS_LABEL = { "chalk:read": "Read only", "chalk:manage": "Read and change" } as const;

/** How to connect an AI app to Chalk, and the apps that signed in to this account through OAuth. */
export function AiAppsPage() {
  const { state, reload, update } = useLoad(() => readPage("connections", {}), "connections");
  const [revoking, setRevoking] = useState<ConnectionDTO | null>(null);
  const toast = useToast();

  return (
    <div className="wrap wide">
      <div className="pgh">
        <h1>AI apps</h1>
      </div>
      <p className="intro">Connect Claude, ChatGPT and other AI apps to Chalk, and they can work with your Spaces for you. You choose what each app is allowed to do.</p>
      {state.kind === "ready" ? (
        <>
          <div className="murl">
            <span className="lbl">Chalk URL</span>
            <code>{state.data.mcpUrl}</code>
            <CopyAction pill small text={state.data.mcpUrl} label="Copy URL" toastMessage="URL copied" />
          </div>
          <McpClients mcpUrl={state.data.mcpUrl} registeredNames={state.data.connections.map((connection) => connection.clientName)} />
        </>
      ) : null}
      {state.kind === "loading" ? (
        <div className="cgrid" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <Sk key={index} width="100%" height={132} radius="16px" />
          ))}
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div style={{ marginTop: 32 }}>
          <ErrorPanel title="Couldn’t load your AI apps" detail={errorMessage(state.error)} onRetry={reload} />
        </div>
      ) : null}
      {state.kind === "ready" ? (
        <div className="secth" style={{ marginTop: 48 }}>
          <h2>Connected apps</h2>
        </div>
      ) : null}
      {state.kind === "ready" && state.data.connections.length === 0 ? (
        <div className="list">
          <div className="empty">
            <b>No connected apps</b>
            <p>Pick an app above and approve it here. It then shows up in this list.</p>
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
        <MoreButton label="Show more apps" cursor={state.data.nextCursor} load={(cursor) => readPage("connections", { cursor })} onLoaded={(page) => update((value) => ({ ...value, connections: [...value.connections, ...page.connections], nextCursor: page.nextCursor }))} />
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
    </div>
  );
}
