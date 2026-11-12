import { Icon } from "../site/Icon";
import { KEY_PREFIX_LENGTH, SIGNING_PREFIX_LENGTH } from "./developer-snippets";
import { Dialog } from "./kit";
import { SecretField } from "./SecretField";

export function Cancel({ onClose }: { readonly onClose: () => void }) {
  return (
    <button type="button" className="btn gh lg" onClick={onClose}>
      Cancel
    </button>
  );
}

export function FieldError({ id, children }: { readonly id: string; readonly children: string }) {
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
  const body = key ? "Store it in your server’s secrets now. Chalk shows the full key once, so if you lose it, rotate the key to get a new one." : "Use it to check that each request came from Chalk. Chalk shows it only once.";
  const after = !secret.rotated ? null : key || secret.rotated.stoppedOld ? "The old secret has stopped working." : "The old secret keeps working for 24 hours, so you can switch over.";
  return (
    <Dialog
      icon="check"
      tone="ok"
      title={title}
      description={body}
      hint={
        <>
          <Icon name="lock" size={14} />
          Only the first and last characters show
        </>
      }
      onClose={onClose}
      actions={
        <button type="button" className="btn pri lg" onClick={onClose}>
          Done
        </button>
      }
    >
      <div>
        <div className="lbl">
          <Icon name="key" size={14} />
          {key ? "Secret key" : "Signing secret"}
        </div>
        <SecretField secret={secret.secret} prefixLength={key ? KEY_PREFIX_LENGTH : SIGNING_PREFIX_LENGTH} noun={key ? "key" : "secret"} />
        <p className="help">Copy puts the full {key ? "key" : "secret"} on your clipboard. Chalk never shows it on screen unless you choose to.</p>
      </div>
      <div className="warnbox">
        <Icon name="warn" size={16} />
        <span>{after ?? (key ? "If you lose it, rotate the key to get a new one. The old secret stops working at once." : "If you lose it, rotate the secret to get a new one.")}</span>
      </div>
    </Dialog>
  );
}
