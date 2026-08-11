import { useEffect, useRef, useState, type FormEvent } from "react";
import { createAPIKey, createRecentAuthProof, DashboardAPIError, type DashboardAPIKey, type DashboardPagination, type RecentAuthProof, listAPIKeys, revokeAPIKey, rotateAPIKey, startRecentAuthGoogle } from "../../lib/dashboard-api";
import { Icon, ResourcePageHeader } from "./DashboardShell";
import { useModalDialog } from "./SpaceDialogPrimitives";
import { EpisodeDiagnosticsLauncher } from "../../features/episode-debugger/EpisodeDiagnosticsLauncher";

type SecretState = { action: "created" | "rotated"; key: DashboardAPIKey; secret: string } | null;
type PendingAction = { kind: "create" | "rotate" | "revoke"; key?: Pick<DashboardAPIKey, "id" | "name">; requestKey?: string } | null;
type StoredPendingMutation = { version: 1; tenantID: string; pending: Exclude<PendingAction, null>; name: string; scopes: string[]; expiresAt: string };
type RestoredPendingMutation = { pending: PendingAction; name: string; scopes: string[]; expiresAt: string } | null;
type GoogleAuthMessage = { type: "chalk.recent-auth.google.complete"; proof?: string; expires_at?: string; error?: { code?: string; message?: string } };

const defaultScopes = ["spaces:read", "episodes:read"];
const API_KEY_PAGE_SIZE = 25;
const PENDING_MUTATION_STORAGE_KEY = "chalk.api-key.pending-recent-auth";
const GOOGLE_AUTH_MESSAGE_TYPE = "chalk.recent-auth.google.complete";

export function APIKeysPage({ tenantID }: { tenantID: string }) {
  const [restored] = useState<RestoredPendingMutation>(() => readPendingMutation(tenantID));
  const [keys, setKeys] = useState<DashboardAPIKey[]>([]);
  const [pagination, setPagination] = useState<DashboardPagination | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DashboardAPIError | Error | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState(restored?.name ?? "");
  const [scopes, setScopes] = useState(restored?.scopes ?? defaultScopes);
  const [expiresAt, setExpiresAt] = useState(restored?.expiresAt ?? defaultExpiry());
  const [pending, setPending] = useState<PendingAction>(restored?.pending ?? null);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [secret, setSecret] = useState<SecretState>(null);
  const [copied, setCopied] = useState(false);
  const previousTenantID = useRef(tenantID);
  const requestedCursor = previousTenantID.current === tenantID ? cursorHistory.at(-1) : undefined;

  useEffect(() => {
    if (previousTenantID.current === tenantID) return;
    previousTenantID.current = tenantID;
    setKeys([]);
    setPagination(null);
    setCursorHistory([]);
    setLoading(true);
    setError(null);
    setCreateOpen(false);
    setName("");
    setScopes(defaultScopes);
    setExpiresAt(defaultExpiry());
    setPending(null);
    setPassword("");
    setAuthError(null);
    setMutating(false);
    setOauthBusy(false);
    setSecret(null);
    setCopied(false);
  }, [tenantID]);

  useEffect(() => {
    if (!pending) {
      removePendingMutation();
      return;
    }
    writePendingMutation({ tenantID, pending, name, scopes, expiresAt });
  }, [expiresAt, name, pending, scopes, tenantID]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setPagination(null);
    listAPIKeys(tenantID, { cursor: requestedCursor, pageSize: API_KEY_PAGE_SIZE })
      .then((response) => {
        if (!active) return;
        setKeys(response.api_keys);
        setPagination(response.pagination);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setPagination(null);
        setError(reason instanceof Error ? reason : new Error("Could not load API keys"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [cursorHistory, requestedCursor, tenantID]);

  const refresh = async () => {
    setError(null);
    setLoading(true);
    setPagination(null);
    try {
      const response = await listAPIKeys(tenantID, { cursor: requestedCursor, pageSize: API_KEY_PAGE_SIZE });
      setKeys(response.api_keys);
      setPagination(response.pagination);
    } catch (reason) {
      setPagination(null);
      setError(reason instanceof Error ? reason : new Error("Could not load API keys"));
    } finally {
      setLoading(false);
    }
  };

  const finishMutation = async (proof: RecentAuthProof) => {
    if (!pending) return;
    if (pending.kind === "create") {
      const response = await createAPIKey(tenantID, { name: name.trim(), scopes, expires_at: new Date(`${expiresAt}T23:59:59.000Z`).toISOString() }, { idempotencyKey: pending.requestKey, recentAuth: proof.proof });
      setSecret({ action: "created", key: response.api_key, secret: response.secret });
      setCreateOpen(false);
      setName("");
      setScopes(defaultScopes);
      setExpiresAt(defaultExpiry());
    } else if (pending.kind === "rotate" && pending.key) {
      const response = await rotateAPIKey(tenantID, pending.key.id, {}, { idempotencyKey: pending.requestKey, recentAuth: proof.proof });
      setSecret({ action: "rotated", key: response.api_key, secret: response.secret });
    } else if (pending.kind === "revoke" && pending.key) {
      await revokeAPIKey(tenantID, pending.key.id, { recentAuth: proof.proof });
    }
    setPending(null);
    setPassword("");
    await refresh();
  };

  const submitRecentAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pending || !password.trim() || mutating || oauthBusy) return;
    setMutating(true);
    setAuthError(null);
    try {
      const action = `api_key.${pending.kind}`;
      const proof = await createRecentAuthProof({ password, action, resource_id: pending.key?.id ?? tenantID });
      await finishMutation(proof);
    } catch (reason) {
      if (reason instanceof DashboardAPIError && reason.code === "api_key.secret_not_replayable") await refresh();
      setAuthError(mutationErrorMessage(reason, true));
    } finally {
      setMutating(false);
    }
  };

  const continueWithGoogle = async () => {
    if (!pending || mutating || oauthBusy) return;
    setOauthBusy(true);
    setAuthError(null);
    try {
      const action = `api_key.${pending.kind}`;
      const resourceID = pending.key?.id ?? tenantID;
      const start = await startRecentAuthGoogle({ action, resource_id: resourceID });
      if (!start.state || !isSafeOAuthURL(start.authorization_url)) throw new Error("Google verification could not start safely.");
      const popup = window.open(start.authorization_url, "chalk-recent-auth", "popup,width=520,height=680,resizable=yes");
      if (!popup) throw new Error("Allow pop-ups for Chalk to continue with Google.");
      const proof = await waitForGoogleAuth(popup);
      setMutating(true);
      await finishMutation(proof);
    } catch (reason) {
      if (reason instanceof DashboardAPIError && reason.code === "api_key.secret_not_replayable") await refresh();
      setAuthError(mutationErrorMessage(reason));
    } finally {
      setMutating(false);
      setOauthBusy(false);
    }
  };

  return (
    <div className="dashboard-page resource-page">
      <ResourcePageHeader eyebrow="Build with Chalk" title="Developer" description="Credentials and integration tools for the product you are building on top of Chalk." actionLabel="New API key" onAction={() => setCreateOpen(true)} />

      <EpisodeDiagnosticsLauncher />

      <section className="contract-state api-key-panel" aria-labelledby="api-keys-heading">
        <div className="dashboard-page-header">
          <div>
            <p className="eyebrow">Credentials</p>
            <h2 id="api-keys-heading">API keys</h2>
            <p>Use a key from your server to call Chalk. Secrets appear once, then rotation is the recovery path.</p>
          </div>
          <span aria-hidden="true">
            <Icon name="developer" />
          </span>
        </div>

        {loading ? <p className="fixture-note">Loading keys…</p> : null}
        {!loading && error ? (
          <div role="alert" className="contract-rule">
            <strong>Could not load API keys</strong>
            <span>{error.message}</span>
            <button className="dashboard-button secondary" type="button" onClick={refresh}>
              Try again
            </button>
            {cursorHistory.length > 0 ? (
              <button className="dashboard-button secondary" type="button" onClick={() => setCursorHistory((current) => current.slice(0, -1))}>
                Back to newer keys
              </button>
            ) : null}
          </div>
        ) : null}
        {!loading && !error && keys.length === 0 ? (
          <div className="contract-rule">
            <strong>{cursorHistory.length > 0 ? "No API keys on this page" : "No API keys yet"}</strong>
            <span>{cursorHistory.length > 0 ? "There are no more keys after this page." : "Create one when you are ready to connect an existing Space to your application."}</span>
          </div>
        ) : null}
        {!loading && !error && keys.length > 0 ? (
          <div className="space-list" aria-label="API keys">
            {keys.map((key) => (
              <APIKeyRow key={key.id} apiKey={key} onRotate={() => setPending({ kind: "rotate", key, requestKey: newIdempotencyKey() })} onRevoke={() => setPending({ kind: "revoke", key })} />
            ))}
          </div>
        ) : null}
        {!loading && !error && pagination && (pagination.has_more || cursorHistory.length > 0) ? (
          <nav className="episode-pagination api-key-pagination" aria-label="API key inventory pages">
            <button className="dashboard-button secondary" type="button" onClick={() => setCursorHistory((current) => current.slice(0, -1))} disabled={cursorHistory.length === 0}>
              Newer keys
            </button>
            <span>Page {cursorHistory.length + 1}</span>
            <button
              className="dashboard-button secondary"
              type="button"
              onClick={() => {
                if (pagination.next_cursor) setCursorHistory((current) => [...current, pagination.next_cursor as string]);
              }}
              disabled={!pagination.has_more || !pagination.next_cursor}
            >
              Older keys
            </button>
          </nav>
        ) : null}
      </section>

      <CreateAPIKeyDialog
        open={createOpen}
        name={name}
        scopes={scopes}
        expiresAt={expiresAt}
        onClose={() => setCreateOpen(false)}
        onNameChange={setName}
        onScopesChange={setScopes}
        onExpiresAtChange={setExpiresAt}
        onContinue={() => {
          setAuthError(null);
          setPending({ kind: "create", requestKey: newIdempotencyKey() });
          setCreateOpen(false);
        }}
      />

      <RecentAuthDialog
        pending={pending}
        password={password}
        error={authError}
        mutating={mutating}
        oauthBusy={oauthBusy}
        onPasswordChange={setPassword}
        onGoogle={continueWithGoogle}
        onClose={() => {
          if (!mutating && !oauthBusy) {
            setPending(null);
            setPassword("");
            setAuthError(null);
          }
        }}
        onSubmit={submitRecentAuth}
      />

      <SecretDialog
        secret={secret}
        copied={copied}
        onCopied={() => setCopied(true)}
        onClose={() => {
          setSecret(null);
          setCopied(false);
        }}
      />
    </div>
  );
}

function APIKeyRow({ apiKey, onRotate, onRevoke }: { apiKey: DashboardAPIKey; onRotate: () => void; onRevoke: () => void }) {
  const revoked = Boolean(apiKey.revoked_at);
  const expired = !revoked && Date.parse(apiKey.expires_at) <= Date.now();
  const state = revoked ? "Revoked" : expired ? "Expired" : "Active";
  return (
    <article className="space-list-item api-key-row">
      <span className="space-glyph" aria-hidden="true">
        <Icon name="developer" />
      </span>
      <div className="space-list-copy">
        <h3>{apiKey.name}</h3>
        <p>
          <code>{apiKey.key_prefix}••••••••</code>
        </p>
        <p>{apiKey.scopes.join(" · ")}</p>
      </div>
      <div className="space-list-state">
        <span className={state === "Active" ? "status-live" : "status-idle"}>{state}</span>
        <small>{apiKey.last_used_at ? `Used ${formatDate(apiKey.last_used_at)}` : "Not used yet"}</small>
      </div>
      <time dateTime={apiKey.expires_at}>Expires {formatDate(apiKey.expires_at)}</time>
      <div className="api-key-actions">
        <button className="dashboard-button secondary" type="button" onClick={onRotate} disabled={revoked || expired}>
          Rotate
        </button>
        <button className="dashboard-button secondary" type="button" onClick={onRevoke} disabled={revoked || expired} aria-label={`Revoke ${apiKey.name}`}>
          Revoke
        </button>
      </div>
    </article>
  );
}

function CreateAPIKeyDialog(props: { open: boolean; name: string; scopes: string[]; expiresAt: string; onClose: () => void; onNameChange: (value: string) => void; onScopesChange: (value: string[]) => void; onExpiresAtChange: (value: string) => void; onContinue: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useModalDialog(dialogRef, props.open);
  const availableScopes = ["spaces:read", "spaces:write", "episodes:read", "episodes:write"];
  return (
    <dialog ref={dialogRef} className="space-dialog api-key-dialog" onClose={props.onClose} onCancel={props.onClose}>
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          props.onContinue();
        }}
      >
        <div className="space-dialog-accent" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <button className="dialog-close" value="cancel" aria-label="Close dialog">
          ×
        </button>
        <p className="eyebrow">Developer access</p>
        <h2>New API key</h2>
        <p className="dialog-intro">Choose the smallest set of scopes your server needs. You will see the secret once.</p>
        <label htmlFor="api-key-name">Key name</label>
        <input id="api-key-name" value={props.name} onChange={(event) => props.onNameChange(event.target.value)} placeholder="e.g. Production backend" required autoFocus />
        <label htmlFor="api-key-expiry">Expires</label>
        <input id="api-key-expiry" type="date" value={props.expiresAt} onChange={(event) => props.onExpiresAtChange(event.target.value)} required />
        <fieldset>
          <legend>Scopes</legend>
          {availableScopes.map((scope) => (
            <label className="visibility-option" key={scope}>
              <input type="checkbox" checked={props.scopes.includes(scope)} onChange={(event) => props.onScopesChange(event.target.checked ? [...props.scopes, scope] : props.scopes.filter((item) => item !== scope))} />
              <span>
                <strong>{scope}</strong>
                <small>{scope.startsWith("spaces") ? "Read or manage Spaces" : "Read or manage Episodes"}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <button value="cancel" className="dashboard-button secondary">
            Cancel
          </button>
          <button className="dashboard-button primary" type="submit" disabled={!props.name.trim() || props.scopes.length === 0}>
            Continue
          </button>
        </div>
      </form>
    </dialog>
  );
}

function RecentAuthDialog({
  pending,
  password,
  error,
  mutating,
  oauthBusy,
  onPasswordChange,
  onGoogle,
  onClose,
  onSubmit,
}: {
  pending: PendingAction;
  password: string;
  error: string | null;
  mutating: boolean;
  oauthBusy: boolean;
  onPasswordChange: (value: string) => void;
  onGoogle: () => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useModalDialog(dialogRef, Boolean(pending));
  if (!pending) return null;
  const destructive = pending.kind === "revoke";
  return (
    <dialog ref={dialogRef} className="space-dialog api-key-dialog" onClose={onClose} onCancel={onClose}>
      <form onSubmit={onSubmit}>
        <div className="space-dialog-accent" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <button className="dialog-close" type="button" onClick={onClose} aria-label="Close dialog">
          ×
        </button>
        <p className="eyebrow">Security check</p>
        <h2>{destructive ? "Revoke this key?" : "Confirm with your password"}</h2>
        <p className="dialog-intro">{destructive ? `Anyone using ${pending.key?.name ?? "this key"} will lose access immediately.` : "This action creates a credential that is shown only once."}</p>
        <label htmlFor="recent-auth-password">Dashboard password</label>
        <input id="recent-auth-password" type="password" autoComplete="current-password" value={password} onChange={(event) => onPasswordChange(event.target.value)} required autoFocus />
        {error ? (
          <p role="alert" className="fixture-note">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button className="dashboard-button secondary" type="button" onClick={onClose} disabled={mutating || oauthBusy}>
            Cancel
          </button>
          <button className="dashboard-button primary" type="submit" disabled={mutating || oauthBusy || !password.trim()}>
            {mutating ? "Checking…" : destructive ? "Revoke key" : "Confirm"}
          </button>
        </div>
        <div className="dialog-divider" aria-hidden="true">
          <span>or</span>
        </div>
        <button className="dashboard-button secondary" type="button" onClick={onGoogle} disabled={mutating || oauthBusy}>
          {oauthBusy ? "Waiting for Google…" : "Continue with Google"}
        </button>
        <p className="fixture-note">Use Google when this Account does not have a dashboard password.</p>
      </form>
    </dialog>
  );
}

function SecretDialog({ secret, copied, onCopied, onClose }: { secret: SecretState; copied: boolean; onCopied: () => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const [copyFallback, setCopyFallback] = useState(false);
  useModalDialog(dialogRef, Boolean(secret));
  if (!secret) return null;
  const copySecret = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(secret.secret);
      setCopyFallback(false);
      onCopied();
    } catch {
      secretRef.current?.focus();
      secretRef.current?.select();
      setCopyFallback(true);
      onCopied();
    }
  };
  return (
    <dialog ref={dialogRef} className="space-dialog api-key-dialog" onClose={onClose} onCancel={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (copied) onClose();
        }}
      >
        <div className="space-dialog-accent" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow">One-time secret</p>
        <h2>{secret.action === "created" ? "API key created" : "API key rotated"}</h2>
        <p className="dialog-intro">Copy this secret now. Chalk will not show it again; if it is lost, rotate the key.</p>
        <label htmlFor="api-key-secret">Secret</label>
        <input ref={secretRef} id="api-key-secret" value={secret.secret} readOnly aria-describedby="secret-warning secret-copy-status" />
        <p id="secret-warning" className="fixture-note">
          Never put this value in source control, browser storage, analytics, or a client bundle.
        </p>
        <p id="secret-copy-status" className="fixture-note" role="status">
          {copyFallback ? "Clipboard access is unavailable. The secret is selected; use your keyboard copy command." : copied ? "Secret copied." : ""}
        </p>
        <div className="dialog-actions">
          <button className="dashboard-button secondary" type="button" onClick={copySecret}>
            {copyFallback ? "Selected" : copied ? "Copied" : "Copy secret"}
          </button>
          <button className="dashboard-button primary" type="submit" disabled={!copied}>
            Done — I copied it
          </button>
        </div>
      </form>
    </dialog>
  );
}

function defaultExpiry() {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + 90);
  return value.toISOString().slice(0, 10);
}

function readPendingMutation(tenantID: string): RestoredPendingMutation {
  if (typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(PENDING_MUTATION_STORAGE_KEY) ?? "null");
    if (!isRecord(value) || value.version !== 1 || value.tenantID !== tenantID || !isRecord(value.pending)) return null;
    const kind = value.pending.kind;
    if (kind !== "create" && kind !== "rotate" && kind !== "revoke") return null;
    const requestKey = value.pending.requestKey;
    if ((kind === "create" || kind === "rotate") && (typeof requestKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(requestKey))) return null;
    const rawKey = value.pending.key;
    const key = rawKey === undefined ? undefined : isRecord(rawKey) && typeof rawKey.id === "string" && typeof rawKey.name === "string" ? { id: rawKey.id, name: rawKey.name } : null;
    if (key === null || (kind !== "create" && !key)) return null;
    if (typeof value.name !== "string" || typeof value.expiresAt !== "string" || !Array.isArray(value.scopes) || value.scopes.some((scope) => typeof scope !== "string")) return null;
    return {
      pending: { kind, ...(key ? { key } : {}), ...(typeof requestKey === "string" ? { requestKey } : {}) },
      name: value.name,
      scopes: value.scopes as string[],
      expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}

function writePendingMutation(input: { tenantID: string; pending: Exclude<PendingAction, null>; name: string; scopes: string[]; expiresAt: string }): void {
  if (typeof window === "undefined") return;
  const pending = {
    kind: input.pending.kind,
    ...(input.pending.key ? { key: { id: input.pending.key.id, name: input.pending.key.name } } : {}),
    ...(input.pending.requestKey ? { requestKey: input.pending.requestKey } : {}),
  } as Exclude<PendingAction, null>;
  try {
    window.sessionStorage.setItem(PENDING_MUTATION_STORAGE_KEY, JSON.stringify({ version: 1, tenantID: input.tenantID, pending, name: input.name, scopes: input.scopes, expiresAt: input.expiresAt } satisfies StoredPendingMutation));
  } catch {
    // A blocked browser store must not prevent the user from completing the in-memory flow.
  }
}

function removePendingMutation(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PENDING_MUTATION_STORAGE_KEY);
  } catch {
    // Ignore storage failures; secrets and proofs never use this store.
  }
}

function mutationErrorMessage(reason: unknown, passwordFlow = false): string {
  if (reason instanceof DashboardAPIError && (reason.code === "auth.invalid_recent_auth" || reason.code === "access.recent_auth_required")) return passwordFlow ? "That password was not accepted. Try again." : "Google verification was not accepted. Try again.";
  if (reason instanceof DashboardAPIError && reason.code === "api_key.secret_not_replayable") return "This request already created the key, but Chalk will not show its secret again. Close this prompt and rotate the key to recover access.";
  return reason instanceof Error ? reason.message : "The action could not be completed.";
}

function isSafeOAuthURL(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function waitForGoogleAuth(popup: Window): Promise<RecentAuthProof> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutID = window.setTimeout(() => rejectOnce(new Error("Google verification timed out. Try again.")), 5 * 60 * 1000);
    const pollID = window.setInterval(() => {
      if (popup.closed) rejectOnce(new Error("Google verification was cancelled."));
    }, 250);
    const cleanup = () => {
      window.clearTimeout(timeoutID);
      window.clearInterval(pollID);
      window.removeEventListener("message", onMessage);
    };
    const rejectOnce = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const resolveOnce = (proof: RecentAuthProof) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(proof);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== popup) return;
      const message = parseGoogleAuthMessage(event.data);
      if (!message) return;
      if (message.error) {
        rejectOnce(new DashboardAPIError(401, message.error.code ?? "auth.invalid_recent_auth", message.error.message ?? "Recent authentication failed"));
        return;
      }
      if (message.proof && message.expires_at) resolveOnce({ proof: message.proof, expires_at: message.expires_at });
    };
    window.addEventListener("message", onMessage);
  });
}

function parseGoogleAuthMessage(value: unknown): GoogleAuthMessage | null {
  if (!isRecord(value) || value.type !== GOOGLE_AUTH_MESSAGE_TYPE) return null;
  if (value.proof !== undefined && typeof value.proof !== "string") return null;
  if (value.expires_at !== undefined && typeof value.expires_at !== "string") return null;
  if (value.error !== undefined && (!isRecord(value.error) || (value.error.code !== undefined && typeof value.error.code !== "string") || (value.error.message !== undefined && typeof value.error.message !== "string"))) return null;
  if (!value.proof && !value.error) return null;
  return value as unknown as GoogleAuthMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function newIdempotencyKey() {
  return crypto.randomUUID().replaceAll("-", "");
}

function formatDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(parsed);
}
