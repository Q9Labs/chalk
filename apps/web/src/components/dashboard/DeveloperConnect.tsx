import { useEffect, useId, useState, type KeyboardEvent } from "react";

import type { KeyDTO } from "../../lib/dashboard/contracts";
import { publicAPIBaseURL } from "../../lib/chalk-access";
import { Icon, type IconName } from "../site/Icon";
import { publicPrefix, REDACTED_TAIL, SNIPPET_TABS, snippetLines, snippetNote, snippetText, type SnippetLine, type SnippetTab, type Token } from "./developer-snippets";
import { CopyAction, useCopy } from "./kit";
import { KeyPicker } from "./KeyPicker";

export type FreshSecret = { readonly secret: string; readonly keyId: string | null };

const TOKEN_CLASS: Record<Exclude<Token["kind"], "secret" | "plain">, string> = { comment: "c", key: "k", string: "s", value: "v", punct: "p" };
const TAB_ICON: Record<SnippetTab, IconName | null> = { env: "file", curl: "terminal", ts: null };

export function ConnectPanel({ tenantId, keys, fresh, onCreateKey }: { readonly tenantId: string; readonly keys: readonly KeyDTO[]; readonly fresh: FreshSecret | null; readonly onCreateKey: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const freshId = fresh?.keyId ?? null;
  // A key just made or rotated is the one the person is about to paste.
  useEffect(() => {
    if (freshId) setPicked(freshId);
  }, [freshId]);
  const key = keys.find((item) => item.id === picked) ?? keys[0] ?? null;
  const secret = key && fresh && fresh.keyId === key.id ? fresh.secret : null;

  return (
    <section className="panel card" id="connect" aria-labelledby="connect-title">
      <div className="ph">
        <Icon name="link" size={18} />
        <div>
          <h2 id="connect-title">Connect your app</h2>
          <div className="sub">Two values and a server. Browsers never get a key; they get an AccessGrant.</div>
        </div>
        <span className="end">
          <a className="btn gh" href="/docs/quickstart">
            Quickstart
            <Icon name="ext" size={16} />
          </a>
        </span>
      </div>
      <div className="body">
        <div className="creds">
          <div>
            <div className="lbl">
              <Icon name="hash" size={14} />
              Tenant ID
            </div>
            <div className="fld">
              <span className="mono">{tenantId}</span>
              <CopyAction text={tenantId} label="Copy tenant ID" toastMessage="Tenant ID copied" />
            </div>
          </div>
          <KeyPicker keys={keys} selected={key} onPick={setPicked} onCreateKey={onCreateKey} />
        </div>
        <Snippet tenantId={tenantId} apiKey={key} secret={secret} />
      </div>
    </section>
  );
}

function renderToken(token: Token, apiKey: KeyDTO | null, index: number) {
  if (token.kind === "secret") {
    return (
      <span className="secret" key={index}>
        {apiKey ? publicPrefix(apiKey.prefix) : null}
        <i>{REDACTED_TAIL}</i>
      </span>
    );
  }
  if (token.kind === "plain") return token.text;
  return (
    <span className={TOKEN_CLASS[token.kind]} key={index}>
      {token.text}
    </span>
  );
}

function Snippet({ tenantId, apiKey, secret }: { readonly tenantId: string; readonly apiKey: KeyDTO | null; readonly secret: string | null }) {
  const [chosen, setTab] = useState<SnippetTab>("env");
  const { copied, copy } = useCopy("Snippet copied");
  const id = useId();
  const tabs = apiKey ? SNIPPET_TABS : SNIPPET_TABS.slice(0, 1);
  const tab = tabs.some((item) => item.id === chosen) ? chosen : "env";
  const lines: readonly SnippetLine[] = apiKey ? snippetLines(tab, { tenantId, apiOrigin: publicAPIBaseURL() }) : [[{ kind: "comment", text: "# Create an API key to fill this in" }]];

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const at = tabs.findIndex((item) => item.id === tab);
    const target = { ArrowRight: at + 1, ArrowLeft: at - 1 + tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    const next = target === undefined ? undefined : tabs[target % tabs.length];
    if (!next) return;
    event.preventDefault();
    setTab(next.id);
    document.getElementById(`${id}-${next.id}`)?.focus();
  }

  return (
    <div className="code">
      <div className="bar" role="tablist" aria-label="Code">
        {tabs.map((item) => {
          const icon = TAB_ICON[item.id];
          return (
            <button key={item.id} id={`${id}-${item.id}`} type="button" role="tab" className="tab" aria-selected={tab === item.id} aria-controls={`${id}-panel`} tabIndex={tab === item.id ? 0 : -1} onKeyDown={onTabKeyDown} onClick={() => setTab(item.id)}>
              {icon ? <Icon name={icon} size={14} /> : <img src="/brand/technology/typescript.svg" alt="" width={14} height={14} />}
              {item.label}
            </button>
          );
        })}
        {apiKey ? (
          <span className="end">
            <button type="button" className={copied ? "btn sm copied" : "btn sm out"} onClick={() => void copy(snippetText(lines, { prefix: apiKey.prefix, secret }))}>
              <Icon name={copied ? "check" : "copy"} size={16} />
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </span>
        ) : null}
      </div>
      <div className="scroll" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        <pre>
          {lines.map((line, index) => (
            <div className="ln" key={index}>
              <span className="no">{index + 1}</span>
              <span>{line.length ? line.map((token, at) => renderToken(token, apiKey, at)) : " "}</span>
            </div>
          ))}
        </pre>
      </div>
      {apiKey ? (
        <div className="note">
          <Icon name="lock" size={14} />
          <span>{snippetNote(tab)}</span>
        </div>
      ) : null}
    </div>
  );
}
