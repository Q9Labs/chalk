import { useState } from "react";
import { useMediaQuery } from "../../internal/useMediaQuery";
import { ChalkMenu, ChalkMenuItem, ChalkSheet } from "../chalk-ui";
import { StageIcon } from "../stage/StageIcon";

type TileAction = { readonly label: string; readonly run: () => void };

/** A tile's More menu. On a phone or a touch screen it opens as a sheet, like the people-row options, so it does not cover the tiles beside it. */
export function TileOptions({ name, actions }: { readonly name: string; readonly actions: readonly TileAction[] }) {
  const sheet = useMediaQuery("(max-width: 640px), (pointer: coarse)");
  const [open, setOpen] = useState(false);
  const trigger = (
    <button
      type="button"
      aria-label={`More options for ${name}`}
      onClick={sheet ? () => setOpen(true) : undefined}
      className="grid h-8 w-8 place-items-center rounded-full bg-[var(--chalk-overlay)] text-[var(--chalk-on-overlay)] outline-none hover:bg-[var(--chalk-overlay-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]"
    >
      <StageIcon name="more" size={18} />
    </button>
  );
  if (!sheet) {
    return (
      <ChalkMenu trigger={trigger}>
        {actions.map((action) => (
          <ChalkMenuItem key={action.label} onClick={action.run}>
            {action.label}
          </ChalkMenuItem>
        ))}
      </ChalkMenu>
    );
  }
  return (
    <>
      {trigger}
      <ChalkSheet open={open} onOpenChange={setOpen} title={`Options for ${name}`}>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="chalk-menu-item"
            onClick={() => {
              setOpen(false);
              action.run();
            }}
          >
            {action.label}
          </button>
        ))}
      </ChalkSheet>
    </>
  );
}
