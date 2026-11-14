import { useEffect, useState } from "react";

import type { DeliveryDTO, DeveloperDTO, WebhookDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { clock, sessionDay } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { useLoad } from "./use-dashboard";
import { Favicon, hostOf } from "./Favicon";
import { ErrorPanel, MoreButton, SkeletonRows, useIntentKeys, usePhone, useToast } from "./kit";

type Pill = readonly ["ok" | "bad" | "warn" | "acc" | "mu", string];
const DELIVERY: Record<string, Pill> = {
  delivered: ["ok", "Delivered"],
  failed: ["bad", "Failed"],
  retrying: ["warn", "Retrying"],
  pending: ["acc", "Queued"],
};
const deliveryPill = (state: string): Pill => DELIVERY[state] ?? ["mu", state];

/** An enabled endpoint whose newest delivery failed. */
export const isFailing = (webhook: WebhookDTO): boolean => webhook.enabled && webhook.lastDelivery?.state === "failed";

function StatePill({ pill }: { readonly pill: Pill }) {
  return (
    <span className={`pill ${pill[0]}`}>
      <span className="d" />
      {pill[1]}
    </span>
  );
}

type Props = {
  readonly webhooks: readonly WebhookDTO[];
  readonly nextCursor: string | null;
  readonly opened: string | null;
  readonly onToggle: (id: string) => void;
  readonly onAdd: () => void;
  readonly onRotate: (webhook: WebhookDTO) => void;
  readonly onEdit: (webhook: WebhookDTO) => void;
  readonly onMore: (page: DeveloperDTO) => void;
};

export function WebhooksPanel({ webhooks, nextCursor, opened, onToggle, onAdd, onRotate, onEdit, onMore }: Props) {
  return (
    <section className="panel card" id="webhooks" aria-labelledby="webhooks-title">
      <div className="ph">
        <Icon name="hook" size={18} />
        <h2 id="webhooks-title">Webhook endpoints</h2>
        {webhooks.length ? <span className="pill">{webhooks.length}</span> : null}
        {webhooks.length ? (
          <span className="end">
            <button type="button" className="btn out" onClick={onAdd}>
              <Icon name="plus" size={16} />
              Add endpoint
            </button>
          </span>
        ) : null}
      </div>
      {webhooks.length === 0 ? (
        <div className="blank">
          <span className="tile">
            <Icon name="hook" size={20} />
          </span>
          <b>No endpoints yet</b>
          <p>Add one to hear when an Episode starts or ends, a Participant joins or leaves, or a Recording is ready.</p>
          <button type="button" className="btn out" onClick={onAdd}>
            <Icon name="plus" size={16} />
            Add endpoint
          </button>
        </div>
      ) : (
        <div className="eps">
          {webhooks.map((webhook) => (
            <Endpoint key={webhook.id} webhook={webhook} open={opened === webhook.id} onToggle={() => onToggle(webhook.id)} onRotate={() => onRotate(webhook)} onEdit={() => onEdit(webhook)} />
          ))}
        </div>
      )}
      {nextCursor ? <MoreButton label="Show more endpoints" cursor={nextCursor} load={(webhookCursor) => readPage("developer", { webhookCursor })} onLoaded={onMore} /> : null}
    </section>
  );
}

function Endpoint({ webhook, open, onToggle, onRotate, onEdit }: { readonly webhook: WebhookDTO; readonly open: boolean; readonly onToggle: () => void; readonly onRotate: () => void; readonly onEdit: () => void }) {
  const phone = usePhone();
  // The list carries each endpoint's last delivery; once the details load, their newest row is fresher.
  const [latest, setLatest] = useState<DeliveryDTO | null | undefined>(undefined);
  const last = latest === undefined ? webhook.lastDelivery : latest;
  const pill: Pill | null = !webhook.enabled ? ["mu", "Paused"] : last ? deliveryPill(last.state) : last === null ? ["mu", "No deliveries yet"] : null;

  return (
    <div className="ep">
      <button type="button" className="eph" aria-expanded={open} aria-controls={`endpoint-${webhook.id}`} onClick={onToggle}>
        <Icon name="right" size={16} className="chev" />
        <Favicon host={hostOf(webhook.url)} large />
        <span className="nmw">
          <b className="ell">{webhook.name}</b>
          <span className="u mono ell">{webhook.url}</span>
        </span>
        <span className="pill ev">{webhook.eventTypes.length} events</span>
        <span className="st">
          {pill ? <StatePill pill={pill} /> : null}
          {last && !phone ? <span className="mu num">{clock(last.createdAt)}</span> : null}
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
    <div className="epb" id={`endpoint-${webhook.id}`}>
      <div className="in">
        <dl className="kv">
          <dt>
            <Icon name="send" size={16} />
            Events
          </dt>
          <dd>
            {webhook.eventTypes.map((type) => (
              <span className="chip mono" key={type}>
                {type}
              </span>
            ))}
            <button type="button" className="btn gh" onClick={onEdit}>
              <Icon name="edit" size={16} />
              Edit events
            </button>
          </dd>
          <dt>
            <Icon name="lock" size={16} />
            Signing secret
          </dt>
          <dd>
            <span className="mono mu">whsec_••••••••</span>
            <button type="button" className="btn out" onClick={onRotate}>
              <Icon name="retry" size={16} />
              Rotate secret
            </button>
            <p>The secret is shown once, when it’s made. Rotating keeps the old one working for 24 hours unless you stop it.</p>
          </dd>
          <dt>
            <Icon name="play" size={14} />
            Test
          </dt>
          <dd>
            <button type="button" className="btn out" onClick={() => void test()}>
              <Icon name="send" size={16} />
              Send test event
            </button>
            <p>Sends a signed test Event to this URL and adds it to recent deliveries.</p>
          </dd>
        </dl>
        <div className="dl">
          <h3>
            <Icon name="clock" size={14} />
            Recent deliveries
          </h3>
          {state.kind === "loading" ? (
            <SkeletonRows count={2} />
          ) : state.kind === "error" ? (
            <ErrorPanel title="Couldn’t load deliveries" detail={errorMessage(state.error)} onRetry={reload} />
          ) : !deliveries?.length ? (
            <p className="tempty">No deliveries yet. Send a test event to try the endpoint.</p>
          ) : (
            <div className="rows" role="table" aria-label="Recent deliveries">
              <div className="row head" role="row">
                <div role="columnheader">Event</div>
                <div role="columnheader">Status</div>
                <div className="r" role="columnheader">
                  Response
                </div>
                <div className="r" role="columnheader">
                  Attempts
                </div>
                <div role="columnheader">Time</div>
                <div role="columnheader">
                  <span className="sr">Actions</span>
                </div>
              </div>
              {deliveries.map((delivery) => (
                <div className="row" role="row" key={delivery.id}>
                  <div className="mono ell" role="cell">
                    {delivery.eventType}
                  </div>
                  <div role="cell">
                    <StatePill pill={deliveryPill(delivery.state)} />
                  </div>
                  <div className="r mono num" role="cell">
                    {delivery.status ?? "–"}
                  </div>
                  <div className="r num" role="cell">
                    {delivery.attempts}
                  </div>
                  <div className="mu" role="cell">
                    {sessionDay(delivery.createdAt)}, {clock(delivery.createdAt)}
                  </div>
                  <div className="r" role="cell">
                    {delivery.state === "failed" ? (
                      <button type="button" className="btn out" onClick={() => void redeliver(delivery)}>
                        Redeliver
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
