import { useRef, useState } from "react";

import type { DeveloperAction, KeyDTO, WebhookDTO } from "../../lib/dashboard/contracts";
import { dashboardWebsiteOrigin } from "../../lib/dashboard/contracts";
import { act, errorMessage } from "../../lib/dashboard/client";
import { fullDate } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { CopyAction, Dialog, Seg, useIntentKeys, useToast } from "./kit";

type CreateKey = Extract<DeveloperAction, { action: "create-key" }>;
type Scope = CreateKey["scopes"][number];
type EventType = Extract<DeveloperAction, { action: "create-webhook" }>["eventTypes"][number];

const RESOURCES = [
  ["spaces", "Spaces"],
  ["episodes", "Episodes"],
  ["recordings", "Recordings"],
  ["transcriptions", "Transcripts"],
  ["webhooks", "Webhooks"],
] as const;
const ALL_SCOPES: readonly Scope[] = RESOURCES.flatMap(([resource]) => [`${resource}:read`, `${resource}:write`] as const);
type Access = "full" | "read" | "custom";
const ACCESS: readonly (readonly [Access, string])[] = [
  ["full", "Full access"],
  ["read", "Read only"],
  ["custom", "Custom"],
];
const EXPIRY: readonly (readonly ["30" | "90" | "365", string])[] = [
  ["30", "30 days"],
  ["90", "90 days"],
  ["365", "1 year"],
];
const EVENT_GROUPS: readonly (readonly [string, readonly EventType[]])[] = [
  ["Episode", ["episode.started", "episode.ended"]],
  ["Participant", ["participant.joined", "participant.left"]],
  ["Recording", ["recording.started", "recording.completed", "recording.failed"]],
  ["Transcript", ["transcript.started", "transcript.completed", "transcript.failed"]],
  ["Space", ["space.created", "space.updated", "space.archived", "space.restored"]],
];

/** "Full access", "Read only", or the resources it touches. */
export function accessLabel(scopes: readonly string[]): string {
  if (ALL_SCOPES.every((scope) => scopes.includes(scope))) return "Full access";
  if (scopes.every((scope) => scope.endsWith(":read")) && RESOURCES.every(([resource]) => scopes.includes(`${resource}:read`))) return "Read only";
  return RESOURCES.filter(([resource]) => scopes.some((scope) => scope.startsWith(`${resource}:`)))
    .map(([, label]) => label)
    .join(", ");
}

function Cancel({ onClose }: { readonly onClose: () => void }) {
  return (
    <button type="button" className="btn gh" onClick={onClose}>
      Cancel
    </button>
  );
}

function FieldError({ id, children }: { readonly id: string; readonly children: string }) {
  return (
    <p className="err" id={id}>
      <Icon name="alert" />
      {children}
    </p>
  );
}

export type Secret = { readonly kind: "key" | "webhook"; readonly secret: string; readonly rotated?: { readonly name: string; readonly stoppedOld: boolean } };

export function SecretDialog({ secret, onClose }: { readonly secret: Secret; readonly onClose: () => void }) {
  const key = secret.kind === "key";
  const title = key ? (secret.rotated ? `New secret for ${secret.rotated.name}` : "Copy your secret key") : secret.rotated ? "New signing secret" : "Copy your signing secret";
  const body = key ? "Store it in your server’s secrets now. Chalk shows it only once, so if you lose it, rotate the key to get a new one." : "Use it to check that each request came from Chalk. Chalk shows it only once.";
  const after = !secret.rotated ? null : key || secret.rotated.stoppedOld ? "The old secret has stopped working." : "The old secret keeps working for 24 hours, so you can switch over.";
  return (
    <Dialog
      title={title}
      description={body}
      onClose={onClose}
      actions={
        <button type="button" className="btn pri" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="secret">
        <div className="linkbox">
          <span>{secret.secret}</span>
        </div>
        <CopyAction text={secret.secret} label="Copy" pill toastMessage="Secret copied" />
      </div>
      {after ? (
        <p className="help" style={{ marginTop: 12 }}>
          {after}
        </p>
      ) : null}
    </Dialog>
  );
}

export function CreateKeyDialog({ onClose, onCreated }: { readonly onClose: () => void; readonly onCreated: (secret: string) => void }) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<Access>("full");
  const [expiry, setExpiry] = useState<"30" | "90" | "365">("90");
  const [openedAt] = useState(Date.now);
  const [custom, setCustom] = useState<readonly Scope[]>([]);
  const [errors, setErrors] = useState<{ name?: boolean; scopes?: boolean }>({});
  const [saving, setSaving] = useState(false);
  // Keyed by the request itself: a retry reuses the key, a changed request gets a new one.
  const intents = useIntentKeys();
  const nameInput = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const expiresAt = new Date(openedAt + Number(expiry) * 24 * 60 * 60 * 1000).toISOString();

  async function create() {
    const trimmed = name.trim();
    const scopes = access === "full" ? ALL_SCOPES : access === "read" ? ALL_SCOPES.filter((scope) => scope.endsWith(":read")) : custom;
    if (!trimmed || !scopes.length) {
      setErrors({ name: !trimmed, scopes: !scopes.length });
      if (!trimmed) nameInput.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const request = { name: trimmed, scopes: [...scopes], expiresAt };
      const { secret } = await act("developer", { action: "create-key", ...request, idempotencyKey: intents.key(JSON.stringify(request)) });
      onCreated(secret);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title="Create API key"
      description="Use the key on your server. It can do what its access allows, until it expires or you revoke it."
      wide={access === "custom"}
      onClose={onClose}
      onSubmit={() => void create()}
      actions={
        <>
          <Cancel onClose={onClose} />
          <button type="submit" className="btn pri" disabled={saving}>
            Create key
          </button>
        </>
      }
    >
      <div className="field" style={{ marginTop: 18 }}>
        <label className="lbl" htmlFor="key-name">
          Name
        </label>
        <input
          ref={nameInput}
          id="key-name"
          className={errors.name ? "inp bad" : "inp"}
          value={name}
          placeholder="For example, Production server"
          maxLength={120}
          autoComplete="off"
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "key-name-error" : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((value) => ({ ...value, name: false }));
          }}
        />
        {errors.name ? <FieldError id="key-name-error">Give the key a name, so you know where it’s used.</FieldError> : null}
      </div>
      <div className="field">
        <span className="lbl" id="key-access">
          Access
        </span>
        <Seg labelledBy="key-access" options={ACCESS} value={access} onChange={setAccess} />
        <p className="help">{access === "full" ? "Reads and changes everything in this account." : access === "read" ? "Reads calls, sessions and recordings. Changes nothing." : "Pick what this key can read and change."}</p>
        {access === "custom" ? (
          <div className="scopes" role="group" aria-label="Scopes">
            <span className="h">Resource</span>
            <span className="h">Read</span>
            <span className="h">Write</span>
            {RESOURCES.map(([resource, label]) => (
              <ScopeRow
                key={resource}
                resource={resource}
                label={label}
                chosen={custom}
                onChange={(next) => {
                  setCustom(next);
                  setErrors((value) => ({ ...value, scopes: false }));
                }}
              />
            ))}
          </div>
        ) : null}
        {errors.scopes ? <FieldError id="key-scope-error">Choose at least one scope.</FieldError> : null}
      </div>
      <div className="field">
        <span className="lbl" id="key-expiry">
          Expires
        </span>
        <Seg labelledBy="key-expiry" options={EXPIRY} value={expiry} onChange={setExpiry} />
        <p className="help">On {fullDate(expiresAt)}.</p>
      </div>
    </Dialog>
  );
}

function ScopeRow({ resource, label, chosen, onChange }: { readonly resource: (typeof RESOURCES)[number][0]; readonly label: string; readonly chosen: readonly Scope[]; readonly onChange: (scopes: readonly Scope[]) => void }) {
  return (
    <>
      <span>{label}</span>
      {(["read", "write"] as const).map((mode) => {
        const scope: Scope = `${resource}:${mode}`;
        return (
          <label key={mode}>
            <input type="checkbox" aria-label={`${label} ${mode}`} checked={chosen.includes(scope)} onChange={(event) => onChange(event.target.checked ? [...chosen, scope] : chosen.filter((item) => item !== scope))} />
          </label>
        );
      })}
    </>
  );
}

export function RotateKeyDialog({ apiKey, onClose, onRotated }: { readonly apiKey: KeyDTO; readonly onClose: () => void; readonly onRotated: (secret: string) => void }) {
  // Keyed by the request itself: a retry reuses the key, a changed request gets a new one.
  const intents = useIntentKeys();
  const toast = useToast();
  return (
    <Dialog
      alert
      title={`Rotate the secret for ${apiKey.name}?`}
      description="The current secret stops working at once. Anything still using it fails until you give it the new one."
      onClose={onClose}
      actions={
        <>
          <Cancel onClose={onClose} />
          <button
            type="button"
            className="btn pri"
            onClick={() =>
              act("developer", { action: "rotate-key", keyId: apiKey.id, expiresAt: apiKey.expiresAt, idempotencyKey: intents.key("rotate") }).then(
                ({ secret }) => onRotated(secret),
                (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
              )
            }
          >
            Rotate secret
          </button>
        </>
      }
    />
  );
}

export function RevokeKeyDialog({ apiKey, onClose, onRevoked }: { readonly apiKey: KeyDTO; readonly onClose: () => void; readonly onRevoked: () => void }) {
  const toast = useToast();
  return (
    <Dialog
      alert
      title={`Revoke ${apiKey.name}?`}
      description="Anything using this key stops working at once. You can’t undo this."
      onClose={onClose}
      actions={
        <>
          <Cancel onClose={onClose} />
          <button
            type="button"
            className="btn dz"
            onClick={() =>
              act("developer", { action: "revoke-key", keyId: apiKey.id }).then(
                () => {
                  onRevoked();
                  toast(`Revoked ${apiKey.name}`, { icon: "trash" });
                },
                (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
              )
            }
          >
            Revoke key
          </button>
        </>
      }
    />
  );
}

const EVENT_NAMES: readonly string[] = EVENT_GROUPS.flatMap(([, types]) => types);
const isEventType = (value: string): value is EventType => EVENT_NAMES.includes(value);

type EndpointDialogProps = { readonly onClose: () => void } & ({ readonly webhook?: undefined; readonly onCreated: (webhook: WebhookDTO, secret: string) => void } | { readonly webhook: WebhookDTO; readonly onSaved: (webhook: WebhookDTO) => void });

/** Adds an endpoint, or edits an existing one's events. Editing never sends the URL: the list only has it redacted. */
export function EndpointDialog(props: EndpointDialogProps) {
  const { webhook, onClose } = props;
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<readonly EventType[]>(webhook ? webhook.eventTypes.filter(isEventType) : ["episode.started", "episode.ended"]);
  const [errors, setErrors] = useState<{ name?: boolean; url?: boolean; events?: boolean }>({});
  const [saving, setSaving] = useState(false);
  // Keyed by the request itself: a retry reuses the key, a changed request gets a new one.
  const intents = useIntentKeys();
  const toast = useToast();

  async function save() {
    const next = { name: !webhook && !name.trim(), url: !webhook && !/^https:\/\/[^\s/]+\.[^\s]+/.test(url.trim()), events: !events.length };
    if (next.name || next.url || next.events) {
      setErrors(next);
      document.getElementById(next.name ? "endpoint-name" : next.url ? "endpoint-url" : "endpoint-events")?.focus();
      return;
    }
    setSaving(true);
    try {
      if (props.webhook) {
        const request = { webhookId: props.webhook.id, eventTypes: [...events], revision: props.webhook.revision };
        const { webhook: saved } = await act("developer", { action: "update-webhook", ...request, idempotencyKey: intents.key(JSON.stringify(request)) });
        props.onSaved(saved);
        return;
      }
      const request = { name: name.trim(), url: url.trim(), enabled: true, eventTypes: [...events] };
      const { webhook: created, secret } = await act("developer", { action: "create-webhook", ...request, idempotencyKey: intents.key(JSON.stringify(request)) });
      props.onCreated(created, secret);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={webhook ? `Events for ${webhook.name}` : "Add endpoint"}
      description={
        webhook ? (
          <>
            Sends to <span className="mono">{webhook.url}</span>. To change the URL, add a new endpoint.
          </>
        ) : (
          "Chalk sends a signed POST to this URL for each event you pick."
        )
      }
      wide
      onClose={onClose}
      onSubmit={() => void save()}
      actions={
        <>
          <Cancel onClose={onClose} />
          <button type="submit" className="btn pri" disabled={saving}>
            {webhook ? "Save events" : "Add endpoint"}
          </button>
        </>
      }
    >
      {webhook ? null : (
        <>
          <div className="field" style={{ marginTop: 18 }}>
            <label className="lbl" htmlFor="endpoint-name">
              Name
            </label>
            <input
              id="endpoint-name"
              className={errors.name ? "inp bad" : "inp"}
              value={name}
              placeholder="For example, Attendance sync"
              maxLength={120}
              autoComplete="off"
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "endpoint-name-error" : undefined}
              onChange={(event) => setName(event.target.value)}
            />
            {errors.name ? <FieldError id="endpoint-name-error">Give the endpoint a name.</FieldError> : null}
          </div>
          <div className="field">
            <label className="lbl" htmlFor="endpoint-url">
              URL
            </label>
            <input
              id="endpoint-url"
              className={errors.url ? "inp mono bad" : "inp mono"}
              value={url}
              placeholder="https://example.com/chalk/webhooks"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(errors.url)}
              aria-describedby={errors.url ? "endpoint-url-error" : undefined}
              onChange={(event) => setUrl(event.target.value)}
            />
            {errors.url ? <FieldError id="endpoint-url-error">Use a public https:// URL.</FieldError> : null}
          </div>
        </>
      )}
      <fieldset className="field" style={webhook ? { marginTop: 18 } : undefined}>
        <legend className="lbl">Events</legend>
        <div className="evgrid">
          {EVENT_GROUPS.map(([group, types], groupIndex) => (
            <div key={group}>
              <h4>{group}</h4>
              {types.map((type, index) => (
                <label className="chk" key={type}>
                  <input id={groupIndex === 0 && index === 0 ? "endpoint-events" : undefined} type="checkbox" checked={events.includes(type)} onChange={(event) => setEvents(event.target.checked ? [...events, type] : events.filter((item) => item !== type))} />
                  {type}
                </label>
              ))}
            </div>
          ))}
        </div>
        {errors.events ? <FieldError id="endpoint-events-error">Pick at least one event.</FieldError> : null}
      </fieldset>
    </Dialog>
  );
}

export function RotateWebhookDialog({ webhook, onClose, onRotated }: { readonly webhook: WebhookDTO; readonly onClose: () => void; readonly onRotated: (secret: string, stoppedOld: boolean) => void }) {
  const [now, setNow] = useState(false);
  // Keyed by the request itself: a retry reuses the key, a changed request gets a new one.
  const intents = useIntentKeys();
  const toast = useToast();
  return (
    <Dialog
      alert
      title="Rotate the signing secret?"
      description={`Chalk signs ${webhook.name} events with a new secret from now on. The old one keeps working for 24 hours, so you can switch without missing events.`}
      onClose={onClose}
      actions={
        <>
          <Cancel onClose={onClose} />
          <button
            type="button"
            className={now ? "btn dz" : "btn pri"}
            onClick={() =>
              act("developer", { action: "rotate-webhook-secret", webhookId: webhook.id, revokePreviousImmediately: now, idempotencyKey: intents.key(String(now)) }).then(
                ({ secret }) => onRotated(secret, now),
                (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
              )
            }
          >
            Rotate secret
          </button>
        </>
      }
    >
      <label className="chk" style={{ marginTop: 16 }}>
        <input type="checkbox" checked={now} onChange={(event) => setNow(event.target.checked)} />
        <span>
          Stop the old secret now
          <small>Use this if the old secret leaked. Events signed with it fail at once.</small>
        </span>
      </label>
    </Dialog>
  );
}

const HTTPS_ORIGIN = /^https:\/\/(localhost|([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(:\d{1,5})?$/;
const LOCAL_ORIGIN = /^http:\/\/localhost:\d{1,5}$/;

export function AddWebsiteDialog({ origins, onClose, onSaved }: { readonly origins: readonly string[]; readonly onClose: () => void; readonly onSaved: (origins: readonly string[], added: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  async function save() {
    const origin = value.trim().toLowerCase().replace(/\/$/, "");
    const problem =
      !HTTPS_ORIGIN.test(origin) && !LOCAL_ORIGIN.test(origin)
        ? "Use a website like https://app.example.com, with no path. For local work, use http://localhost with a port."
        : origin === dashboardWebsiteOrigin
          ? "chalkmeet.com is always allowed."
          : origins.includes(origin)
            ? "That website is already on the list."
            : "";
    if (problem) {
      setError(problem);
      input.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const { allowedWebsites } = await act("developer", { action: "set-allowed-websites", origins: [...origins, origin] });
      onSaved(allowedWebsites, origin);
    } catch (failure) {
      toast(errorMessage(failure), { icon: "alert" });
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      title="Add website"
      description="Chalk calls can then load inside this website, using this account’s keys."
      onClose={onClose}
      onSubmit={() => void save()}
      actions={
        <>
          <Cancel onClose={onClose} />
          <button type="submit" className="btn pri" disabled={saving}>
            Add website
          </button>
        </>
      }
    >
      <div className="field" style={{ marginTop: 16 }}>
        <label className="lbl" htmlFor="website-input">
          Website
        </label>
        <input
          ref={input}
          id="website-input"
          className={error ? "inp mono bad" : "inp mono"}
          value={value}
          placeholder="https://app.example.com"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "website-error" : "website-help"}
          onChange={(event) => {
            setValue(event.target.value);
            setError("");
          }}
        />
        {error ? (
          <FieldError id="website-error">{error}</FieldError>
        ) : (
          <p className="help" id="website-help">
            Only the website itself: https, the host, and a port if it has one.
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function RemoveWebsiteDialog({ origin, origins, onClose, onSaved }: { readonly origin: string; readonly origins: readonly string[]; readonly onClose: () => void; readonly onSaved: (origins: readonly string[]) => void }) {
  const toast = useToast();
  return (
    <Dialog
      alert
      title="Remove this website?"
      description={
        <>
          <span className="mono">{origin}</span> stops loading Chalk calls at once. You can add it again later.
        </>
      }
      onClose={onClose}
      actions={
        <>
          <Cancel onClose={onClose} />
          <button
            type="button"
            className="btn dz"
            onClick={() =>
              act("developer", { action: "set-allowed-websites", origins: origins.filter((item) => item !== origin) }).then(
                ({ allowedWebsites }) => {
                  onSaved(allowedWebsites);
                  toast(`Removed ${origin}`, { icon: "trash" });
                },
                (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
              )
            }
          >
            Remove website
          </button>
        </>
      }
    />
  );
}
