import { useState } from "react";
import { type DeveloperAction, type WebhookDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage } from "../../lib/dashboard/client";
import { Dialog } from "./Dialog";
import { useIntentKeys, useToast } from "./kit";
import { Cancel, FieldError, FormActions } from "./developer-dialog-parts";

type EventType = Extract<DeveloperAction, { action: "create-webhook" }>["eventTypes"][number];

const EVENT_GROUPS: readonly (readonly [string, readonly EventType[]])[] = [
  ["Episode", ["episode.started", "episode.ended"]],
  ["Participant", ["participant.joined", "participant.left"]],
  ["Recording", ["recording.started", "recording.completed", "recording.failed"]],
  ["Transcript", ["transcript.started", "transcript.completed", "transcript.failed"]],
  ["Space", ["space.created", "space.updated", "space.archived", "space.restored"]],
];

const EVENT_NAMES: readonly string[] = EVENT_GROUPS.flatMap(([, types]) => types);
const isEventType = (value: string): value is EventType => EVENT_NAMES.includes(value);

type EndpointErrors = { name?: boolean; url?: boolean; events?: boolean };

function EndpointFields({ name, url, errors, onName, onUrl }: { readonly name: string; readonly url: string; readonly errors: EndpointErrors; readonly onName: (name: string) => void; readonly onUrl: (url: string) => void }) {
  return (
    <>
      <div className="field" style={{ marginTop: "var(--space-4)" }}>
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
          onChange={(event) => onName(event.target.value)}
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
          onChange={(event) => onUrl(event.target.value)}
        />
        {errors.url ? <FieldError id="endpoint-url-error">Use a public https:// URL.</FieldError> : null}
      </div>
    </>
  );
}

type EventsFieldsetProps = { readonly events: readonly EventType[]; readonly invalid: boolean; readonly spaced: boolean; readonly onChange: (events: readonly EventType[]) => void };

function EventsFieldset({ events, invalid, spaced, onChange }: EventsFieldsetProps) {
  return (
    <fieldset className="field" style={spaced ? { marginTop: "var(--space-4)" } : undefined}>
      <legend className="lbl">Events</legend>
      <div className="evgrid">
        {EVENT_GROUPS.map(([group, types], groupIndex) => (
          <div key={group}>
            <h4>{group}</h4>
            {types.map((type, index) => (
              <label className="chk" key={type}>
                <input id={groupIndex === 0 && index === 0 ? "endpoint-events" : undefined} type="checkbox" checked={events.includes(type)} onChange={(event) => onChange(event.target.checked ? [...events, type] : events.filter((item) => item !== type))} />
                {type}
              </label>
            ))}
          </div>
        ))}
      </div>
      {invalid ? <FieldError id="endpoint-events-error">Pick at least one event.</FieldError> : null}
    </fieldset>
  );
}

type EndpointDialogProps = { readonly onClose: () => void } & ({ readonly webhook?: undefined; readonly onCreated: (webhook: WebhookDTO, secret: string) => void } | { readonly webhook: WebhookDTO; readonly onSaved: (webhook: WebhookDTO) => void });

/** Adds an endpoint, or edits an existing one's events. Editing never sends the URL: the list only has it redacted. */
export function EndpointDialog(props: EndpointDialogProps) {
  const { webhook, onClose } = props;
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<readonly EventType[]>(webhook ? webhook.eventTypes.filter(isEventType) : ["episode.started", "episode.ended"]);
  const [errors, setErrors] = useState<EndpointErrors>({});
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
      icon="hook"
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
        <FormActions onClose={onClose} busy={saving}>
          {webhook ? "Save events" : "Add endpoint"}
        </FormActions>
      }
    >
      {webhook ? null : <EndpointFields name={name} url={url} errors={errors} onName={setName} onUrl={setUrl} />}
      <EventsFieldset events={events} invalid={Boolean(errors.events)} spaced={Boolean(webhook)} onChange={setEvents} />
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
      icon="retry"
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
      <label className="chk" style={{ marginTop: "var(--space-4)" }}>
        <input type="checkbox" checked={now} onChange={(event) => setNow(event.target.checked)} />
        <span>
          Stop the old secret now
          <small>Use this if the old secret leaked. Events signed with it fail at once.</small>
        </span>
      </label>
    </Dialog>
  );
}
