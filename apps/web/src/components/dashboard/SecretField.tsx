import { useState } from "react";

import { Icon } from "../site/Icon";
import { maskSecret } from "./developer-snippets";
import { useCopy } from "./kit";

/**
 * A secret as it is shown on screen: redacted, with an eye to show it and a Copy that always copies the whole thing.
 * Copying is the reason this field is open, so it stays a labelled primary button rather than the quiet icon.
 */
export function SecretField({ secret, prefixLength, copyLabel = "Copy", noun = "key" }: { readonly secret: string; readonly prefixLength: number; readonly copyLabel?: string; readonly noun?: string }) {
  const [shown, setShown] = useState(false);
  const { copied, copy } = useCopy();
  return (
    <div className="secbox">
      <span className="mono" data-testid="secret-text">
        {shown ? secret : maskSecret(secret, prefixLength)}
      </span>
      <button type="button" className="ib" aria-label={shown ? `Hide ${noun}` : `Show ${noun}`} aria-pressed={shown} onClick={() => setShown((value) => !value)}>
        <Icon name={shown ? "eyeOff" : "eye"} size={18} />
      </button>
      <button type="button" className={copied ? "btn copied" : "btn pri"} aria-label={copied ? "Copied" : copyLabel} onClick={() => void copy(secret)}>
        <Icon name={copied ? "check" : "copy"} size={16} />
        <span>{copied ? "Copied" : copyLabel}</span>
      </button>
    </div>
  );
}
