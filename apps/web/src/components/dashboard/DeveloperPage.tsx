import { useEffect, useState } from "react";

import type { DeliveryDTO, DeveloperDTO, RecordingRenderSettingsDTO, KeyDTO, WebhookDTO } from "../../lib/dashboard/contracts";
import { dashboardWebsiteOrigin } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { ago, clock, expiresSoon, fullDate, sessionDay } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { useLoad } from "./AppShell";
import { accessLabel, EndpointDialog, AddWebsiteDialog, CreateKeyDialog, RemoveWebsiteDialog, RevokeKeyDialog, RotateKeyDialog, RotateWebhookDialog, SecretDialog, type Secret } from "./DeveloperDialogs";
import { ErrorPanel, Menu, MenuItem, MoreButton, Sk, SkeletonRows, useIntentKeys, usePhone, useToast } from "./kit";

type Open =
  | null
  | { readonly kind: "create-key" }
  | { readonly kind: "rotate-key" | "revoke-key"; readonly apiKey: KeyDTO }
  | { readonly kind: "add-endpoint" }
  | { readonly kind: "rotate-webhook" | "edit-endpoint"; readonly webhook: WebhookDTO }
  | { readonly kind: "add-website" }
  | { readonly kind: "remove-website"; readonly origin: string }
  | { readonly kind: "secret"; readonly secret: Secret };

export function DeveloperPage() {
  const { state, reload, update } = useLoad(() => readPage("developer", {}), "developer");
  const [open, setOpen] = useState<Open>(null);
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined);
  const toast = useToast();
  const close = () => setOpen(null);

  const intro = (
    <>
      <div className="pgh">
        <h1>Developer</h1>
      </div>
      <p className="intro">
        Recording preferences, API keys, allowed websites and webhooks for your app. Here a call is a Space and one session is an Episode, the same words the API uses. <a href="/docs/quickstart">Read the docs</a>
      </p>
    </>
  );
  if (state.kind === "loading")
    return (
      <div className="wrap">
        {intro}
        {[3, 2, 2].map((count, index) => (
          <div key={index}>
            <div className="secth">
              <Sk width={["120px", "150px", "180px"][index] ?? "120px"} height={18} />
            </div>
            <SkeletonRows count={count} />
          </div>
        ))}
      </div>
    );
  if (state.kind === "error")
    return (
      <div className="wrap">
        {intro}
        <div style={{ marginTop: 32 }}>
          <ErrorPanel title="Couldn’t load your developer settings" detail={errorMessage(state.error)} onRetry={reload} />
        </div>
      </div>
    );

  const data = state.data;
  const keys = data.keys.filter((key) => !key.revokedAt);
  const origins = data.allowedWebsites.filter((origin) => origin !== dashboardWebsiteOrigin);
  const opened = expanded === undefined ? (data.webhooks[0]?.id ?? null) : expanded;
  const setWebsites = (allowedWebsites: readonly string[]) => update((value): DeveloperDTO => ({ ...value, allowedWebsites }));

  return (
    <div className="wrap">
      {intro}
      <RecordingSettings mode={data.recordingRenderMode} onSaved={(recordingRenderMode) => update((value) => ({ ...value, recordingRenderMode }))} />
      <div className="secth" style={{ marginTop: 48 }}>
        <h2>API keys</h2>
        <button type="button" className="btn sec" onClick={() => setOpen({ kind: "create-key" })}>
          <Icon name="plus" />
          Create API key
        </button>
      </div>
      <KeysTable keys={keys} onRotate={(apiKey) => setOpen({ kind: "rotate-key", apiKey })} onRevoke={(apiKey) => setOpen({ kind: "revoke-key", apiKey })} />
      {data.nextKeyCursor ? <MoreButton label="Show more keys" cursor={data.nextKeyCursor} load={(keyCursor) => readPage("developer", { keyCursor })} onLoaded={(page) => update((value) => ({ ...value, keys: [...value.keys, ...page.keys], nextKeyCursor: page.nextKeyCursor }))} /> : null}

      <div className="secth" style={{ marginTop: 48 }}>
        <h2>Allowed websites</h2>
        <button type="button" className="btn sec" onClick={() => setOpen({ kind: "add-website" })}>
          <Icon name="plus" />
          Add website
        </button>
      </div>
      <div className="list origins">
        <div className="orow">
          <span className="mono">{dashboardWebsiteOrigin}</span>
          <span className="tag">Always allowed</span>
        </div>
        {origins.map((origin) => (
          <div className="orow" key={origin}>
            <span className="mono">{origin}</span>
            <button type="button" className="ib" aria-label={`Remove ${origin}`} data-tip onClick={() => setOpen({ kind: "remove-website", origin })}>
              <Icon name="trash" />
            </button>
          </div>
        ))}
      </div>
      {origins.length ? null : <p className="ohelp">Add the website where your app runs, and Chalk calls can load inside it with this account’s keys.</p>}

      <div className="secth" style={{ marginTop: 48 }}>
        <h2>Webhook endpoints</h2>
        <button type="button" className="btn sec" onClick={() => setOpen({ kind: "add-endpoint" })}>
          <Icon name="plus" />
          Add endpoint
        </button>
      </div>
      {data.webhooks.length === 0 ? (
        <div className="list">
          <div className="empty">
            <b>No endpoints yet</b>
            <p>Add one to hear when an Episode starts or ends, a Participant joins or leaves, or a Recording is ready.</p>
          </div>
        </div>
      ) : (
        <div className="list">
          {data.webhooks.map((webhook) => (
            <Endpoint key={webhook.id} webhook={webhook} open={opened === webhook.id} onToggle={() => setExpanded(opened === webhook.id ? null : webhook.id)} onRotate={() => setOpen({ kind: "rotate-webhook", webhook })} onEdit={() => setOpen({ kind: "edit-endpoint", webhook })} />
          ))}
        </div>
      )}
      {data.nextWebhookCursor ? (
        <MoreButton label="Show more endpoints" cursor={data.nextWebhookCursor} load={(webhookCursor) => readPage("developer", { webhookCursor })} onLoaded={(page) => update((value) => ({ ...value, webhooks: [...value.webhooks, ...page.webhooks], nextWebhookCursor: page.nextWebhookCursor }))} />
      ) : null}

      {open?.kind === "create-key" ? (
        <CreateKeyDialog
          onClose={close}
          onCreated={(secret) => {
            // Refetch in place: a full reload would unmount the button the secret dialog returns focus to.
            readPage("developer", {}).then(
              (page) => update((value) => ({ ...value, keys: page.keys, nextKeyCursor: page.nextKeyCursor })),
              (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
            );
            setOpen({ kind: "secret", secret: { kind: "key", secret } });
          }}
        />
      ) : null}
      {open?.kind === "rotate-key" ? <RotateKeyDialog apiKey={open.apiKey} onClose={close} onRotated={(secret) => setOpen({ kind: "secret", secret: { kind: "key", secret, rotated: { name: open.apiKey.name, stoppedOld: true } } })} /> : null}
      {open?.kind === "revoke-key" ? (
        <RevokeKeyDialog
          apiKey={open.apiKey}
          onClose={close}
          onRevoked={() => {
            update((value) => ({ ...value, keys: value.keys.filter((key) => key.id !== open.apiKey.id) }));
            close();
          }}
        />
      ) : null}
      {open?.kind === "add-endpoint" ? (
        <EndpointDialog
          onClose={close}
          onCreated={(webhook, secret) => {
            update((value) => ({ ...value, webhooks: [...value.webhooks, webhook] }));
            setExpanded(webhook.id);
            setOpen({ kind: "secret", secret: { kind: "webhook", secret } });
          }}
        />
      ) : null}
      {open?.kind === "edit-endpoint" ? (
        <EndpointDialog
          webhook={open.webhook}
          onClose={close}
          onSaved={(saved) => {
            // The save returns the endpoint without its last delivery; keep the one the list had.
            update((value) => ({ ...value, webhooks: value.webhooks.map((item) => (item.id === saved.id ? { ...saved, lastDelivery: item.lastDelivery } : item)) }));
            close();
            toast(`Saved the events for ${saved.name}`);
          }}
        />
      ) : null}
      {open?.kind === "rotate-webhook" ? <RotateWebhookDialog webhook={open.webhook} onClose={close} onRotated={(secret, stoppedOld) => setOpen({ kind: "secret", secret: { kind: "webhook", secret, rotated: { name: open.webhook.name, stoppedOld } } })} /> : null}
      {open?.kind === "add-website" ? (
        <AddWebsiteDialog
          origins={origins}
          onClose={close}
          onSaved={(allowedWebsites, added) => {
            setWebsites(allowedWebsites);
            close();
            toast(`Added ${added}`);
          }}
        />
      ) : null}
      {open?.kind === "remove-website" ? (
        <RemoveWebsiteDialog
          origin={open.origin}
          origins={origins}
          onClose={close}
          onSaved={(allowedWebsites) => {
            setWebsites(allowedWebsites);
            close();
          }}
        />
      ) : null}
      {open?.kind === "secret" ? <SecretDialog secret={open.secret} onClose={close} /> : null}
    </div>
  );
}

function KeysTable({ keys, onRotate, onRevoke }: { readonly keys: readonly KeyDTO[]; readonly onRotate: (key: KeyDTO) => void; readonly onRevoke: (key: KeyDTO) => void }) {
  const phone = usePhone();
  if (!keys.length)
    return (
      <div className="list">
        <div className="empty">
          <b>No API keys yet</b>
          <p>Create one to call the API from your server. Keep it there: browsers get an AccessGrant, never a key.</p>
        </div>
      </div>
    );
  return (
    <div className="list">
      <table className="tbl">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Key</th>
            <th scope="col">Access</th>
            <th scope="col">Expires</th>
            <th scope="col">Last used</th>
            <th scope="col">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const soon = expiresSoon(key.expiresAt);
            return (
              <tr key={key.id}>
                <td>
                  <span className="nm">{key.name}</span>
                </td>
                <td>
                  <span className="mono">{key.prefix}…</span>
                </td>
                <td className="phh">{accessLabel(key.scopes)}</td>
                <td>
                  {soon ? (
                    <span className="wn">
                      <Icon name="warn" />
                      {fullDate(key.expiresAt)}, {soon}
                    </span>
                  ) : (
                    `${phone ? "Expires " : ""}${fullDate(key.expiresAt)}`
                  )}
                </td>
                <td className="phh">{key.lastUsedAt ? ago(key.lastUsedAt) : "Never"}</td>
                <td className="act">
                  <Menu label={`Actions for ${key.name}`}>
                    {(close) => (
                      <>
                        <MenuItem
                          icon="retry"
                          onSelect={() => {
                            close();
                            onRotate(key);
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
                            onRevoke(key);
                          }}
                        >
                          Revoke key
                        </MenuItem>
                      </>
                    )}
                  </Menu>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const DELIVERY: Record<string, readonly [string, string]> = {
  delivered: ["d-ok", "Delivered"],
  failed: ["d-dg", "Failed"],
  retrying: ["d-wn", "Retrying"],
  pending: ["d-in", "Queued"],
};
const deliveryState = (state: string) => DELIVERY[state] ?? (["d-mu", state] as const);

function Endpoint({ webhook, open, onToggle, onRotate, onEdit }: { readonly webhook: WebhookDTO; readonly open: boolean; readonly onToggle: () => void; readonly onRotate: () => void; readonly onEdit: () => void }) {
  const phone = usePhone();
  // The list carries each endpoint's last delivery; once the details load, their newest row is fresher.
  const [latest, setLatest] = useState<DeliveryDTO | null | undefined>(undefined);
  const last = latest === undefined ? webhook.lastDelivery : latest;
  const [dot, label] = !webhook.enabled ? ["d-mu", "Paused"] : last ? deliveryState(last.state) : ["d-mu", last === null ? "No deliveries yet" : ""];

  return (
    <div className="ep">
      <button type="button" className="eph" aria-expanded={open} aria-controls={`endpoint-${webhook.id}`} onClick={onToggle}>
        <Icon name="right" />
        <span style={{ minWidth: 0 }}>
          <b>{webhook.name}</b>
          <span className="mono">{webhook.url}</span>
        </span>
        <span className="mu phh">{webhook.eventTypes.length} events</span>
        <span className="status">
          {label ? <span className={`dot ${dot}`} /> : null}
          {label}
          {last && !phone ? <span className="mu"> · {clock(last.createdAt)}</span> : null}
        </span>
      </button>
      {open ? <EndpointDetails webhook={webhook} onRotate={onRotate} onEdit={onEdit} onLatest={setLatest} /> : null}
    </div>
  );
}

/** An open endpoint. Its deliveries load only while it's open, since each one costs engine reads. */
function EndpointDetails({ webhook, onRotate, onEdit, onLatest }: { readonly webhook: WebhookDTO; readonly onRotate: () => void; readonly onEdit: () => void; readonly onLatest: (delivery: DeliveryDTO | null) => void }) {
  const toast = useToast();
  const intents = useIntentKeys();
  const { state, reload, update } = useLoad(() => act("developer", { action: "webhook-deliveries", webhookId: webhook.id }), `deliveries:${webhook.id}`);
  const deliveries = state.kind === "ready" ? state.data.deliveries : null;
  const newest = deliveries ? (deliveries[0] ?? null) : undefined;
  useEffect(() => {
    if (newest !== undefined) onLatest(newest);
  }, [newest, onLatest]);

  async function test() {
    try {
      await act("developer", { action: "test-webhook", webhookId: webhook.id, idempotencyKey: intents.key("test") });
      intents.done("test");
      toast("Test event sent. It shows in recent deliveries.", { icon: "send" });
      reload();
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }
  async function redeliver(delivery: DeliveryDTO) {
    try {
      await act("developer", { action: "redeliver-webhook", webhookId: webhook.id, deliveryId: delivery.id, idempotencyKey: intents.key(`redeliver:${delivery.id}`) });
      intents.done(`redeliver:${delivery.id}`);
      update((value) => ({ ...value, deliveries: value.deliveries.map((item) => (item.id === delivery.id ? { ...item, state: "pending" } : item)) }));
      toast("The delivery is queued again");
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }

  return (
    <div className="epd" id={`endpoint-${webhook.id}`}>
      <dl className="kv">
        <dt>Events</dt>
        <dd>
          {webhook.eventTypes.map((type) => (
            <span className="chip" key={type}>
              {type}
            </span>
          ))}
          <button type="button" className="btn gh sm" onClick={onEdit}>
            <Icon name="edit" />
            Edit events
          </button>
        </dd>
        <dt>Signing secret</dt>
        <dd>
          <span className="mono mu">whsec_••••••••</span>
          <button type="button" className="btn sec sm" onClick={onRotate}>
            <Icon name="retry" />
            Rotate secret
          </button>
          <p>The secret is shown once, when it’s made. Rotating keeps the old one working for 24 hours unless you stop it.</p>
        </dd>
        <dt>Test</dt>
        <dd>
          <button type="button" className="btn sec sm" onClick={() => void test()}>
            <Icon name="send" />
            Send test event
          </button>
          <p>Sends a signed test Event to this URL and adds it to recent deliveries.</p>
        </dd>
      </dl>
      <div className="dtbl">
        <h3>Recent deliveries</h3>
        {state.kind === "loading" ? (
          <SkeletonRows count={2} />
        ) : state.kind === "error" ? (
          <ErrorPanel title="Couldn’t load deliveries" detail={errorMessage(state.error)} onRetry={reload} />
        ) : !deliveries?.length ? (
          <p className="tempty">No deliveries yet. Send a test event to try the endpoint.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Status</th>
                <th scope="col" className="r">
                  Response
                </th>
                <th scope="col" className="r">
                  Attempts
                </th>
                <th scope="col">Time</th>
                <th scope="col">
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => {
                const [deliveryDot, deliveryLabel] = deliveryState(delivery.state);
                return (
                  <tr key={delivery.id}>
                    <td>
                      <span className="mono">{delivery.eventType}</span>
                    </td>
                    <td>
                      <span className="status">
                        <span className={`dot ${deliveryDot}`} />
                        {deliveryLabel}
                      </span>
                    </td>
                    <td className="r mono num phh">{delivery.status ?? "–"}</td>
                    <td className="r num phh">{delivery.attempts}</td>
                    <td className="phh">
                      {sessionDay(delivery.createdAt)}, {clock(delivery.createdAt)}
                    </td>
                    <td className="act">
                      {delivery.state === "failed" ? (
                        <button type="button" className="btn sec sm" onClick={() => void redeliver(delivery)}>
                          Redeliver
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RecordingSettings({ mode, onSaved }: { readonly mode: RecordingRenderSettingsDTO["recordingRenderMode"]; readonly onSaved: (mode: RecordingRenderSettingsDTO["recordingRenderMode"]) => void }) {
  const [draft, setDraft] = useState(mode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => setDraft(mode), [mode]);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || draft === mode) return;
        setBusy(true);
        setError(null);
        try {
          const result = await act("developer", { action: "set-recording-render-mode", mode: draft });
          onSaved(result.recordingRenderMode);
          toast("Recording settings saved");
        } catch (cause) {
          setError(errorMessage(cause));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="secth">
        <h2>Recordings</h2>
      </div>
      <div className="field">
        <label htmlFor="recording-render-mode">Make recording videos</label>
        <select
          id="recording-render-mode"
          value={draft}
          disabled={busy}
          onChange={(event) => {
            setDraft(event.target.value === "automatic" ? "automatic" : "on_demand");
          }}
          aria-describedby="recording-render-help"
        >
          <option value="on_demand">On demand</option>
          <option value="automatic">Automatically</option>
        </select>
        <p id="recording-render-help">On demand makes an MP4 when you request a video. Automatic makes it after each recorded call ends. This setting applies to all calls in your account.</p>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" className="btn sec" disabled={busy || draft === mode}>
        {busy ? "Saving…" : "Save recording settings"}
      </button>
    </form>
  );
}
