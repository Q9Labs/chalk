import { useRef, useState, type Ref } from "react";
import { SITE_ORIGIN } from "../../lib/site-origin";
import { act, errorMessage } from "../../lib/dashboard/client";
import { Dialog } from "./Dialog";
import { useToast } from "./kit";
import { Cancel, FieldError, FormActions } from "./developer-dialog-parts";

const HTTPS_ORIGIN = /^https:\/\/(localhost|([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(:\d{1,5})?$/;
const LOCAL_ORIGIN = /^http:\/\/localhost:\d{1,5}$/;

/** Why this origin can't go on the list, or an empty string when it can. */
function originProblem(origin: string, origins: readonly string[]): string {
  if (!HTTPS_ORIGIN.test(origin) && !LOCAL_ORIGIN.test(origin)) return "Use a website like https://app.example.com, with no path. For local work, use http://localhost with a port.";
  if (origin === SITE_ORIGIN) return "chalkmeet.com is always allowed.";
  return origins.includes(origin) ? "That website is already on the list." : "";
}

function WebsiteField({ inputRef, value, error, onChange }: { readonly inputRef: Ref<HTMLInputElement>; readonly value: string; readonly error: string; readonly onChange: (value: string) => void }) {
  return (
    <div className="field" style={{ marginTop: "var(--space-4)" }}>
      <label className="lbl" htmlFor="website-input">
        Website
      </label>
      <input
        ref={inputRef}
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
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <FieldError id="website-error">{error}</FieldError>
      ) : (
        <p className="help" id="website-help">
          Only the website itself: https, the host, and a port if it has one.
        </p>
      )}
    </div>
  );
}

export function AddWebsiteDialog({ origins, onClose, onSaved }: { readonly origins: readonly string[]; readonly onClose: () => void; readonly onSaved: (origins: readonly string[], added: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  async function save() {
    const origin = value.trim().toLowerCase().replace(/\/$/, "");
    const problem = originProblem(origin, origins);
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
      icon="globe"
      title="Add website"
      description="Chalk calls can then load inside this website, using this account’s keys."
      onClose={onClose}
      onSubmit={() => void save()}
      actions={
        <FormActions onClose={onClose} busy={saving}>
          Add website
        </FormActions>
      }
    >
      <WebsiteField
        inputRef={input}
        value={value}
        error={error}
        onChange={(next) => {
          setValue(next);
          setError("");
        }}
      />
    </Dialog>
  );
}

export function RemoveWebsiteDialog({ origin, origins, onClose, onSaved }: { readonly origin: string; readonly origins: readonly string[]; readonly onClose: () => void; readonly onSaved: (origins: readonly string[]) => void }) {
  const toast = useToast();
  return (
    <Dialog
      alert
      icon="trash"
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
            className="btn dz lg"
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
