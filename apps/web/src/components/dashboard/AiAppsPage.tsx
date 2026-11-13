import { useState } from "react";

import type { ConnectionDTO, ConnectionsDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { ago, fullDate } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { AppLogo } from "./AppLogo";
import { useLoad } from "./use-dashboard";
import { DisconnectPrompt } from "./DisconnectPrompt";
import { CopyAction, ErrorPanel, MoreButton, Sk, SkeletonRows, useToast } from "./kit";
import { McpClients } from "./McpClients";

const ACCESS_LABEL = { "chalk:read": "Read only", "chalk:manage": "Read and change" } as const;

function ConnectionsTable({ connections, onDisconnect }: { connections: readonly ConnectionDTO[]; onDisconnect: (connection: ConnectionDTO) => void }) {
  return (
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
          {connections.map((connection) => {
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
                  <button type="button" className="ib cdis" data-tip aria-label={`Disconnect ${connection.clientName}`} onClick={() => onDisconnect(connection)}>
                    <Icon name="trash" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RevokeConnection({ connection, onCancel, onRevoked }: { connection: ConnectionDTO; onCancel: () => void; onRevoked: () => void }) {
  const toast = useToast();
  return (
    <DisconnectPrompt
      app={connection.clientName}
      onCancel={onCancel}
      onConfirm={() =>
        act("connections", { action: "revoke-connection", connectionId: connection.id }).then(
          () => {
            onRevoked();
            toast(`Disconnected ${connection.clientName}`, { icon: "trash" });
          },
          (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
        )
      }
    />
  );
}

type LoadedAiAppsProps = {
  data: ConnectionsDTO;
  reload: () => void;
  update: (change: (data: ConnectionsDTO) => ConnectionsDTO) => void;
  onDisconnect: (connection: ConnectionDTO) => void;
};

function LoadedAiApps({ data, reload, update, onDisconnect }: LoadedAiAppsProps) {
  return (
    <>
      <div className="murl">
        <span className="lbl">Chalk URL</span>
        <code>{data.mcpUrl}</code>
        <CopyAction pill small text={data.mcpUrl} label="Copy URL" toastMessage="URL copied" />
      </div>
      <McpClients mcpUrl={data.mcpUrl} registeredNames={[...(data.nextCursor ? data.connectedNames : []), ...data.connections.map((connection) => connection.clientName)]} />
      <div className="secth" style={{ marginTop: "var(--space-12)" }}>
        <h2>Connected apps</h2>
      </div>
      {data.listError ? <ErrorPanel title="Couldn’t load your connected apps" detail="Adding an app above still works." onRetry={reload} /> : null}
      {!data.listError && data.connections.length === 0 ? (
        <div className="list">
          <div className="empty">
            <b>No connected apps</b>
            <p>Pick an app above and approve it here. It then shows up in this list.</p>
          </div>
        </div>
      ) : null}
      {data.connections.length > 0 ? <ConnectionsTable connections={data.connections} onDisconnect={onDisconnect} /> : null}
      {data.nextCursor ? <MoreButton label="Show more apps" cursor={data.nextCursor} load={(cursor) => readPage("connections", { cursor })} onLoaded={(page) => update((value) => ({ ...value, connections: [...value.connections, ...page.connections], nextCursor: page.nextCursor }))} /> : null}
    </>
  );
}

/** How to connect an AI app to Chalk, and the apps that signed in to this account through OAuth. */
export function AiAppsPage() {
  const { state, reload, update } = useLoad(() => readPage("connections", {}), "connections");
  const [revoking, setRevoking] = useState<ConnectionDTO | null>(null);

  return (
    <div className="wrap wide">
      <div className="pgh">
        <h1>AI apps</h1>
      </div>
      <p className="intro">Connect Claude, ChatGPT and other AI apps to Chalk, and they can work with your Spaces for you. You choose what each app is allowed to do.</p>
      {state.kind === "ready" ? <LoadedAiApps data={state.data} reload={reload} update={update} onDisconnect={setRevoking} /> : null}
      {state.kind === "loading" ? <AiAppsSkeleton /> : null}
      {state.kind === "error" ? (
        <div style={{ marginTop: "var(--space-8)" }}>
          <ErrorPanel title="Couldn’t load your AI apps" detail={errorMessage(state.error)} onRetry={reload} />
        </div>
      ) : null}
      {revoking ? (
        <RevokeConnection
          connection={revoking}
          onCancel={() => setRevoking(null)}
          onRevoked={() => {
            update((value) => ({ ...value, connections: value.connections.filter((item) => item.id !== revoking.id) }));
            // With more pages, the catalog's names came from every page, so read them again.
            if (state.kind === "ready" && state.data.nextCursor) reload();
            setRevoking(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** The loaded page's parts in place: the URL row, the search, app tiles and the connected list's heading. */
function AiAppsSkeleton() {
  return (
    <div aria-busy="true">
      <div className="murl">
        <span className="lbl">Chalk URL</span>
        <Sk width="min(320px, 50%)" height={14} />
        <Sk width="96px" height={32} radius="999px" />
      </div>
      <div className="cfind">
        <Sk width="100%" height={44} radius="999px" />
      </div>
      <ul className="cgrid" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <li key={index}>
            <div className="ctile">
              <Sk width="40px" height={40} radius="12px" />
              <span className="ctext">
                <Sk width="96px" height={14} />
                <Sk width="80%" height={12} />
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="secth" style={{ marginTop: "var(--space-12)" }}>
        <h2>Connected apps</h2>
      </div>
      <SkeletonRows count={2} />
    </div>
  );
}
