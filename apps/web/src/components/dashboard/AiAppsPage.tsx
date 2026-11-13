import { useState } from "react";

import type { ConnectionDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { ago, fullDate, isInternalLink } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { AppLogo } from "./AppLogo";
import { useLoad } from "./AppShell";
import { DisconnectPrompt } from "./DisconnectPrompt";
import { ErrorPanel, LinkField, MoreButton, Sk, SkeletonRows, useToast } from "./kit";
import { McpClients } from "./McpClients";

const ACCESS_LABEL = { "chalk:read": "Read only", "chalk:manage": "Read and change" } as const;

/** How to connect an AI app to Chalk, and the apps that signed in to this account through OAuth. */
export function AiAppsPage() {
  const { state, reload, update } = useLoad(() => readPage("connections", {}), "connections");
  const [revoking, setRevoking] = useState<ConnectionDTO | null>(null);
  const toast = useToast();

  return (
    <div className="wrap">
      <div className="pgh">
        <h1>AI apps</h1>
      </div>
      <p className="intro">Let Claude, ChatGPT and other AI apps work with your Spaces. You choose what each one can do.</p>
      {state.kind === "ready" ? (
        <>
          <McpAddress url={state.data.mcpUrl} />
          <McpClients mcpUrl={state.data.mcpUrl} registeredNames={[...(state.data.nextCursor ? state.data.connectedNames : []), ...state.data.connections.map((connection) => connection.clientName)]} />
        </>
      ) : null}
      {state.kind === "loading" ? <AiAppsSkeleton /> : null}
      {state.kind === "error" ? (
        <div style={{ marginTop: "var(--space-8)" }}>
          <ErrorPanel title="Couldn’t load your AI apps" detail={errorMessage(state.error)} onRetry={reload} />
        </div>
      ) : null}
      {state.kind === "ready" ? (
        <div className="secth" style={{ marginTop: "var(--space-12)" }}>
          <h2>Connected apps</h2>
        </div>
      ) : null}
      {state.kind === "ready" && state.data.listError ? <ErrorPanel title="Couldn’t load your connected apps" detail="Your connections are still in place. Try again in a moment." onRetry={reload} /> : null}
      {state.kind === "ready" && !state.data.listError && state.data.connections.length === 0 ? (
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
                // With more pages, the catalog's names came from every page, so read them again.
                if (state.kind === "ready" && state.data.nextCursor) reload();
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

/**
 * The address AI apps add. A test server that only knows its loopback address can't be reached by an AI app, so the
 * page says so instead of showing an address that would not work.
 */
function McpAddress({ url }: { readonly url: string }) {
  if (isInternalLink(url))
    return (
      <div className="murl">
        <span className="lbl">Chalk URL</span>
        <p className="help">AI apps can’t connect to this preview, because it runs on a private address. Connect them from your live Chalk account.</p>
      </div>
    );
  return (
    <div className="murl">
      <span className="lbl">Chalk URL</span>
      <LinkField link={url} shown={url} label="Copy URL" />
    </div>
  );
}

/** The loaded page's parts in place: the URL row, the search, app tiles and the connected list's heading. */
function AiAppsSkeleton() {
  return (
    <div aria-busy="true">
      <div className="murl">
        <span className="lbl">Chalk URL</span>
        <div className="linkfield">
          <Sk width="min(320px, 60%)" height={14} />
        </div>
      </div>
      <h2 className="cgroup">Chat apps</h2>
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
