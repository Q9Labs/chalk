import type { DeveloperDTO, KeyDTO, WebhookDTO } from "../../lib/dashboard/contracts";
import { SecretDialog, type Secret } from "./developer-dialog-parts";
import { CreateKeyDialog, RevokeKeyDialog, RotateKeyDialog } from "./KeyDialogs";
import { useToast } from "./kit";
import { EndpointDialog, RotateWebhookDialog } from "./WebhookDialogs";
import { AddWebsiteDialog, RemoveWebsiteDialog } from "./WebsiteDialogs";

export type OpenDialog =
  | { readonly kind: "create-key" }
  | { readonly kind: "rotate-key" | "revoke-key"; readonly apiKey: KeyDTO }
  | { readonly kind: "add-endpoint" }
  | { readonly kind: "rotate-webhook" | "edit-endpoint"; readonly webhook: WebhookDTO }
  | { readonly kind: "add-website" }
  | { readonly kind: "remove-website"; readonly origin: string }
  | { readonly kind: "secret"; readonly secret: Secret };

type Props = {
  readonly open: OpenDialog | null;
  readonly origins: readonly string[];
  readonly onOpen: (next: OpenDialog | null) => void;
  readonly update: (change: (value: DeveloperDTO) => DeveloperDTO) => void;
  readonly onExpandWebhook: (id: string) => void;
  readonly showSecret: (secret: Secret, fallbackId: string | null) => void;
};

type Update = (change: (value: DeveloperDTO) => DeveloperDTO) => void;
type Close = () => void;
type KeyOpen = Extract<OpenDialog, { kind: "create-key" | "rotate-key" | "revoke-key" }>;
type EndpointOpen = Extract<OpenDialog, { kind: "add-endpoint" | "edit-endpoint" | "rotate-webhook" }>;
type WebsiteOpen = Extract<OpenDialog, { kind: "add-website" | "remove-website" }>;

/** The one dialog the developer page has open, if any. */
export function DeveloperDialogs({ open, origins, onOpen, update, onExpandWebhook, showSecret }: Props) {
  const close = () => onOpen(null);
  if (!open) return null;
  switch (open.kind) {
    case "create-key":
    case "rotate-key":
    case "revoke-key":
      return <KeyDialog open={open} update={update} close={close} showSecret={showSecret} />;
    case "add-endpoint":
    case "edit-endpoint":
    case "rotate-webhook":
      return <EndpointDialogs open={open} update={update} close={close} onOpen={onOpen} onExpandWebhook={onExpandWebhook} />;
    case "add-website":
    case "remove-website":
      return <WebsiteDialog open={open} origins={origins} update={update} close={close} />;
    case "secret":
      return <SecretDialog secret={open.secret} onClose={close} />;
  }
}

function KeyDialog({ open, update, close, showSecret }: { readonly open: KeyOpen; readonly update: Update; readonly close: Close; readonly showSecret: Props["showSecret"] }) {
  switch (open.kind) {
    case "create-key":
      return <CreateKeyDialog onClose={close} onCreated={(secret) => showSecret({ kind: "key", secret }, null)} />;
    case "rotate-key":
      return <RotateKeyDialog apiKey={open.apiKey} onClose={close} onRotated={(secret) => showSecret({ kind: "key", secret, rotated: { name: open.apiKey.name, stoppedOld: true } }, open.apiKey.id)} />;
    case "revoke-key":
      return (
        <RevokeKeyDialog
          apiKey={open.apiKey}
          onClose={close}
          onRevoked={() => {
            update((value) => ({ ...value, keys: value.keys.filter((key) => key.id !== open.apiKey.id) }));
            close();
          }}
        />
      );
  }
}

function EndpointDialogs({ open, update, close, onOpen, onExpandWebhook }: { readonly open: EndpointOpen; readonly update: Update; readonly close: Close; readonly onOpen: Props["onOpen"]; readonly onExpandWebhook: Props["onExpandWebhook"] }) {
  const toast = useToast();
  const showWebhookSecret = (secret: Secret) => onOpen({ kind: "secret", secret });
  switch (open.kind) {
    case "add-endpoint":
      return (
        <EndpointDialog
          onClose={close}
          onCreated={(webhook, secret) => {
            update((value) => ({ ...value, webhooks: [...value.webhooks, webhook] }));
            onExpandWebhook(webhook.id);
            showWebhookSecret({ kind: "webhook", secret });
          }}
        />
      );
    case "edit-endpoint":
      return (
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
      );
    case "rotate-webhook":
      return <RotateWebhookDialog webhook={open.webhook} onClose={close} onRotated={(secret, stoppedOld) => showWebhookSecret({ kind: "webhook", secret, rotated: { name: open.webhook.name, stoppedOld } })} />;
  }
}

function WebsiteDialog({ open, origins, update, close }: { readonly open: WebsiteOpen; readonly origins: readonly string[]; readonly update: Update; readonly close: Close }) {
  const toast = useToast();
  const setWebsites = (allowedWebsites: readonly string[]) => update((value) => ({ ...value, allowedWebsites }));
  switch (open.kind) {
    case "add-website":
      return (
        <AddWebsiteDialog
          origins={origins}
          onClose={close}
          onSaved={(allowedWebsites, added) => {
            setWebsites(allowedWebsites);
            close();
            toast(`Added ${added}`);
          }}
        />
      );
    case "remove-website":
      return (
        <RemoveWebsiteDialog
          origin={open.origin}
          origins={origins}
          onClose={close}
          onSaved={(allowedWebsites) => {
            setWebsites(allowedWebsites);
            close();
          }}
        />
      );
  }
}
