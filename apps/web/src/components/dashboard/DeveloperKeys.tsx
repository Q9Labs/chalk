import type { DeveloperDTO, KeyDTO } from "../../lib/dashboard/contracts";
import { readPage } from "../../lib/dashboard/client";
import { ago, expiresSoon, fullDate, hasExpired } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { accessLabel } from "./KeyDialogs";
import type { FreshSecret } from "./DeveloperConnect";
import { KEY_PREFIX_LENGTH, publicPrefix } from "./developer-snippets";
import { Menu, MenuItem, MoreButton } from "./kit";
import { SecretField } from "./SecretField";

type Props = {
  readonly keys: readonly KeyDTO[];
  readonly nextCursor: string | null;
  readonly fresh: FreshSecret | null;
  readonly onCreate: () => void;
  readonly onRotate: (key: KeyDTO) => void;
  readonly onRevoke: (key: KeyDTO) => void;
  readonly onMore: (page: DeveloperDTO) => void;
};

export function KeysPanel({ keys, nextCursor, fresh, onCreate, onRotate, onRevoke, onMore }: Props) {
  const freshKey = fresh ? keys.find((key) => key.id === fresh.keyId) : undefined;
  return (
    <section className="panel card" id="keys" aria-labelledby="keys-title">
      <div className="ph">
        <Icon name="key" size={18} />
        <h2 id="keys-title">API keys</h2>
        {keys.length ? (
          <span className="end">
            <button type="button" className="btn pri" onClick={onCreate}>
              <Icon name="plus" size={16} />
              Create API key
            </button>
          </span>
        ) : null}
      </div>
      {fresh && freshKey ? <FreshReveal name={freshKey.name} secret={fresh.secret} /> : null}
      {keys.length ? (
        <div className="rows keys" role="table" aria-label="API keys">
          <KeysHead />
          {keys.map((key) => (
            <KeyRow key={key.id} apiKey={key} fresh={fresh?.keyId === key.id} onRotate={onRotate} onRevoke={onRevoke} />
          ))}
        </div>
      ) : (
        <KeysEmpty onCreate={onCreate} />
      )}
      {nextCursor ? <MoreButton label="Show more keys" cursor={nextCursor} load={(keyCursor) => readPage("developer", { keyCursor })} onLoaded={onMore} /> : null}
    </section>
  );
}

function FreshReveal({ name, secret }: { readonly name: string; readonly secret: string }) {
  return (
    <div className="reveal" role="status">
      <span className="tile">
        <Icon name="check" size={18} />
      </span>
      <div className="t">
        <b>{name} is ready</b>
        <p>Copy the secret now. Chalk shows the full key once, and never again.</p>
        <SecretField key={secret} secret={secret} prefixLength={KEY_PREFIX_LENGTH} copyLabel="Copy key" copiedMessage="Secret copied" />
      </div>
    </div>
  );
}

function KeysHead() {
  return (
    <div className="row head" role="row">
      <div role="columnheader">Name</div>
      <div role="columnheader">Key</div>
      <div role="columnheader">Access</div>
      <div role="columnheader">Expires</div>
      <div role="columnheader">Last used</div>
      <div role="columnheader">
        <span className="sr">Actions</span>
      </div>
    </div>
  );
}

function KeysEmpty({ onCreate }: { readonly onCreate: () => void }) {
  return (
    <div className="blank">
      <span className="tile">
        <Icon name="key" size={20} />
      </span>
      <b>No API keys yet</b>
      <p>Create one to call the API from your server. Keep it there: browsers get an AccessGrant, never a key.</p>
      <button type="button" className="btn pri" onClick={onCreate}>
        <Icon name="plus" size={16} />
        Create API key
      </button>
    </div>
  );
}

function KeyActions({ apiKey, onRotate, onRevoke }: { readonly apiKey: KeyDTO; readonly onRotate: (key: KeyDTO) => void; readonly onRevoke: (key: KeyDTO) => void }) {
  return (
    <Menu label={`Actions for ${apiKey.name}`}>
      {(close) => (
        <>
          <MenuItem
            icon="retry"
            onSelect={() => {
              close();
              onRotate(apiKey);
            }}
          >
            Rotate secret
          </MenuItem>
          <div className="msep" />
          <MenuItem
            icon="trash"
            danger
            onSelect={() => {
              close();
              onRevoke(apiKey);
            }}
          >
            Revoke key
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function KeyRow({ apiKey, fresh, onRotate, onRevoke }: { readonly apiKey: KeyDTO; readonly fresh: boolean; readonly onRotate: (key: KeyDTO) => void; readonly onRevoke: (key: KeyDTO) => void }) {
  const expired = hasExpired(apiKey.expiresAt);
  const soon = expired ? undefined : expiresSoon(apiKey.expiresAt);
  return (
    <div className={fresh ? "row new" : "row"} role="row">
      <div className="nm" role="cell">
        <span className="kt">
          <Icon name="key" size={16} />
        </span>
        <span className="t ell">{apiKey.name}</span>
        {fresh ? <span className="pill ok">New</span> : null}
      </div>
      <div role="cell">
        <span className="mono">
          <span className="pre">{publicPrefix(apiKey.prefix)}</span>
          <span className="redact">••••••••</span>
        </span>
      </div>
      <div role="cell">
        <span className="pill">{accessLabel(apiKey.scopes)}</span>
      </div>
      <div className="exp" role="cell">
        <span className="num">{fullDate(apiKey.expiresAt)}</span>
        {expired ? (
          <span className="pill bad">
            <span className="d" />
            Expired
          </span>
        ) : null}
        {soon ? (
          <span className="pill warn">
            <Icon name="clock" size={12} />
            {soon}
          </span>
        ) : null}
      </div>
      <div className={apiKey.lastUsedAt ? "" : "mu"} role="cell">
        {apiKey.lastUsedAt ? ago(apiKey.lastUsedAt) : "Never"}
      </div>
      <div role="cell">
        <KeyActions apiKey={apiKey} onRotate={onRotate} onRevoke={onRevoke} />
      </div>
    </div>
  );
}
