import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { trapDialogFocus } from "../../lib/dialog-focus";
import { Icon, type IconName } from "../site/Icon";

type DialogProps = {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly alert?: boolean;
  readonly wide?: boolean;
  /** On a phone the sheet fills the screen height. */
  readonly tall?: boolean;
  /** Artwork above the title, such as the app and Chalk logos. */
  readonly lead?: ReactNode;
  /** A tile beside the title, the heading shape the Developer dialogs use. Body and actions get their own bands. */
  readonly icon?: IconName;
  readonly tone?: "ok";
  /** Quiet text on the left of the actions. */
  readonly hint?: ReactNode;
  readonly onClose: () => void;
  readonly onSubmit?: () => void;
  readonly children?: ReactNode;
  readonly actions: ReactNode;
};

type InnerProps = Pick<DialogProps, "title" | "description" | "lead" | "icon" | "tone" | "hint" | "onClose" | "children" | "actions"> & {
  readonly titleId: string;
  readonly descriptionId: string;
};

function DialogInner({ title, description, lead, icon, tone, hint, onClose, children, actions, titleId, descriptionId }: InnerProps) {
  const heading = (
    <>
      <h2 id={titleId}>{title}</h2>
      {description ? <p id={descriptionId}>{description}</p> : null}
    </>
  );
  return (
    <>
      <button type="button" className="ib x" aria-label="Close" onClick={onClose}>
        <Icon name="x" />
      </button>
      {lead}
      {icon ? (
        <div className="dh">
          <span className={tone === "ok" ? "tile ok" : "tile"}>
            <Icon name={icon} size={20} />
          </span>
          <div>{heading}</div>
        </div>
      ) : (
        heading
      )}
      {icon && children ? <div className="db">{children}</div> : children}
      <div className="acts">
        {hint ? <span className="hint">{hint}</span> : null}
        {actions}
      </div>
    </>
  );
}

/** Moves focus into the dialog on open and gives it back to whatever opened it on close. */
function useDialogFocus() {
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = card.current?.querySelector<HTMLElement>("[autofocus], input:not([type=checkbox]), .acts .btn:last-child");
    first?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return card;
}

/** A card on a scrim, a bottom sheet on the phone. Traps focus, closes on Esc or the scrim, and gives focus back to whatever opened it. */
export function Dialog({ alert, wide, tall, onClose, onSubmit, ...content }: DialogProps) {
  const card = useDialogFocus();
  const titleId = useId();
  const descriptionId = useId();
  const inner = <DialogInner {...content} onClose={onClose} titleId={titleId} descriptionId={descriptionId} />;
  const shared = {
    className: ["dlg", content.icon && "titled", wide && "w", tall && "tall"].filter(Boolean).join(" "),
    role: alert ? "alertdialog" : "dialog",
    "aria-modal": true,
    "aria-labelledby": titleId,
    "aria-describedby": content.description ? descriptionId : undefined,
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key !== "Escape") return trapDialogFocus(event);
      event.preventDefault();
      onClose();
    },
    ref(node: HTMLElement | null) {
      card.current = node;
    },
  } as const;
  return (
    <div
      className="scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {onSubmit ? (
        <form
          {...shared}
          noValidate
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {inner}
        </form>
      ) : (
        <div {...shared}>{inner}</div>
      )}
    </div>
  );
}
