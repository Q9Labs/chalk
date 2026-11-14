import { useRef, useState, type Ref, type RefObject } from "react";
import { type DeveloperAction, type KeyDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage } from "../../lib/dashboard/client";
import { fullDate } from "../../lib/dashboard/format";
import { Dialog } from "./Dialog";
import { Seg, useIntentKeys, useToast } from "./kit";
import { Cancel, FieldError, FormActions } from "./developer-dialog-parts";

type CreateKey = Extract<DeveloperAction, { action: "create-key" }>;
type Scope = CreateKey["scopes"][number];

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

/** "Full access", "Read only", or the resources it touches. */
export function accessLabel(scopes: readonly string[]): string {
  if (ALL_SCOPES.every((scope) => scopes.includes(scope))) return "Full access";
  if (scopes.every((scope) => scope.endsWith(":read")) && RESOURCES.every(([resource]) => scopes.includes(`${resource}:read`))) return "Read only";
  return RESOURCES.filter(([resource]) => scopes.some((scope) => scope.startsWith(`${resource}:`)))
    .map(([, label]) => label)
    .join(", ");
}

const ACCESS_HELP: Record<Access, string> = {
  full: "Reads and changes everything in this account.",
  read: "Reads calls, sessions and recordings. Changes nothing.",
  custom: "Pick what this key can read and change.",
};

function scopesFor(access: Access, custom: readonly Scope[]): readonly Scope[] {
  if (access === "full") return ALL_SCOPES;
  return access === "read" ? ALL_SCOPES.filter((scope) => scope.endsWith(":read")) : custom;
}

function ScopeGrid({ chosen, onChange }: { readonly chosen: readonly Scope[]; readonly onChange: (scopes: readonly Scope[]) => void }) {
  return (
    <div className="scopes" role="group" aria-label="Scopes">
      <span className="h">Resource</span>
      <span className="h">Read</span>
      <span className="h">Write</span>
      {RESOURCES.map(([resource, label]) => (
        <ScopeRow key={resource} resource={resource} label={label} chosen={chosen} onChange={onChange} />
      ))}
    </div>
  );
}

function NameField({ name, invalid, inputRef, onChange }: { readonly name: string; readonly invalid: boolean; readonly inputRef: Ref<HTMLInputElement>; readonly onChange: (name: string) => void }) {
  return (
    <div className="field" style={{ marginTop: "var(--space-4)" }}>
      <label className="lbl" htmlFor="key-name">
        Name
      </label>
      <input
        ref={inputRef}
        id="key-name"
        className={invalid ? "inp bad" : "inp"}
        value={name}
        placeholder="For example, Production server"
        maxLength={120}
        autoComplete="off"
        aria-invalid={invalid}
        aria-describedby={invalid ? "key-name-error" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {invalid ? <FieldError id="key-name-error">Give the key a name, so you know where it’s used.</FieldError> : null}
    </div>
  );
}

type AccessFieldProps = { readonly access: Access; readonly custom: readonly Scope[]; readonly invalid: boolean; readonly onAccess: (access: Access) => void; readonly onCustom: (scopes: readonly Scope[]) => void };

function AccessField({ access, custom, invalid, onAccess, onCustom }: AccessFieldProps) {
  return (
    <div className="field">
      <span className="lbl" id="key-access">
        Access
      </span>
      <Seg labelledBy="key-access" options={ACCESS} value={access} onChange={onAccess} />
      <p className="help">{ACCESS_HELP[access]}</p>
      {access === "custom" ? <ScopeGrid chosen={custom} onChange={onCustom} /> : null}
      {invalid ? <FieldError id="key-scope-error">Choose at least one scope.</FieldError> : null}
    </div>
  );
}

function ExpiryField({ expiry, expiresAt, onChange }: { readonly expiry: "30" | "90" | "365"; readonly expiresAt: string; readonly onChange: (expiry: "30" | "90" | "365") => void }) {
  return (
    <div className="field">
      <span className="lbl" id="key-expiry">
        Expires
      </span>
      <Seg labelledBy="key-expiry" options={EXPIRY} value={expiry} onChange={onChange} />
      <p className="help">On {fullDate(expiresAt)}.</p>
    </div>
  );
}

/** The chosen lifetime, and the moment it ends counted from when the dialog opened. */
function useExpiry() {
  const [expiry, setExpiry] = useState<"30" | "90" | "365">("90");
  const [openedAt] = useState(Date.now);
  return { expiry, setExpiry, expiresAt: new Date(openedAt + Number(expiry) * 24 * 60 * 60 * 1000).toISOString() };
}

type KeyErrors = { name?: boolean; scopes?: boolean };

/** Validates the form, then creates the key; a retry of the same request reuses its idempotency key. */
function useCreateKey(onCreated: (secret: string) => void, setErrors: (errors: KeyErrors) => void, nameInput: RefObject<HTMLInputElement | null>) {
  const [saving, setSaving] = useState(false);
  const intents = useIntentKeys();
  const toast = useToast();
  async function create(name: string, scopes: readonly Scope[], expiresAt: string) {
    if (!name || !scopes.length) {
      setErrors({ name: !name, scopes: !scopes.length });
      if (!name) nameInput.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const request = { name, scopes: [...scopes], expiresAt };
      onCreated((await act("developer", { action: "create-key", ...request, idempotencyKey: intents.key(JSON.stringify(request)) })).secret);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      setSaving(false);
    }
  }
  return [saving, create] as const;
}

export function CreateKeyDialog({ onClose, onCreated }: { readonly onClose: () => void; readonly onCreated: (secret: string) => void }) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<Access>("full");
  const { expiry, setExpiry, expiresAt } = useExpiry();
  const [custom, setCustom] = useState<readonly Scope[]>([]);
  const [errors, setErrors] = useState<KeyErrors>({});
  const nameInput = useRef<HTMLInputElement>(null);
  const [saving, create] = useCreateKey(onCreated, setErrors, nameInput);

  return (
    <Dialog
      icon="key"
      title="Create API key"
      description="Use the key on your server. It can do what its access allows, until it expires or you revoke it."
      wide={access === "custom"}
      onClose={onClose}
      onSubmit={() => void create(name.trim(), scopesFor(access, custom), expiresAt)}
      actions={
        <FormActions onClose={onClose} busy={saving}>
          Create key
        </FormActions>
      }
    >
      <NameField
        name={name}
        invalid={Boolean(errors.name)}
        inputRef={nameInput}
        onChange={(value) => {
          setName(value);
          setErrors((current) => ({ ...current, name: false }));
        }}
      />
      <AccessField
        access={access}
        custom={custom}
        invalid={Boolean(errors.scopes)}
        onAccess={setAccess}
        onCustom={(next) => {
          setCustom(next);
          setErrors((current) => ({ ...current, scopes: false }));
        }}
      />
      <ExpiryField expiry={expiry} expiresAt={expiresAt} onChange={setExpiry} />
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
      icon="retry"
      title={`Rotate the secret for ${apiKey.name}?`}
      description="The current secret stops working at once. Anything still using it fails until you give it the new one."
      onClose={onClose}
      actions={
        <>
          <Cancel onClose={onClose} />
          <button
            type="button"
            className="btn pri lg"
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
      icon="trash"
      title={`Revoke ${apiKey.name}?`}
      description="Anything using this key stops working at once. You can’t undo this."
      onClose={onClose}
      actions={
        <>
          <Cancel onClose={onClose} />
          <button
            type="button"
            className="btn dz lg"
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
