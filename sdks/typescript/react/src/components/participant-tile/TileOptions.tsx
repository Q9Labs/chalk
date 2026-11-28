import { useState } from "react";
import { useMediaQuery } from "../../internal/useMediaQuery";
import { ChalkMenu, ChalkMenuItem, ChalkSheet } from "../chalk-ui";
import { StageIcon } from "../stage/StageIcon";

export type TileAction = { readonly label: string; readonly run: () => void };

/** The tile's actions in menu order: the main one, then follow. */
export function tileActions(main: { readonly label: string; readonly run?: () => void }, follow: { readonly label: string; readonly run?: () => void }, leading: readonly TileAction[] = []): readonly TileAction[] {
  return [...leading, ...[main, follow].flatMap(({ label, run }) => (run ? [{ label, run }] : []))];
}

/** Where a tile's options live: the phone sheet when a tap on the tile opens it, else a menu button in the tile's corner that shows on hover. */
export function TileOptionsSlot({ name, actions, tapForOptions, open, onOpenChange }: { readonly name: string; readonly actions: readonly TileAction[]; readonly tapForOptions: boolean; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  if (tapForOptions) return <TileOptionsSheet name={name} actions={actions} open={open} onOpenChange={onOpenChange} />;
  if (actions.length === 0) return null;
  return (
    <span data-part="tile-menu" className="absolute top-2 right-2 z-30 opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100 focus-within:opacity-100">
      <TileOptions name={name} actions={actions} />
    </span>
  );
}

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
      <TileOptionsSheet name={name} actions={actions} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** The tile's options as a phone sheet. A phone opens it from a tap on the tile itself, so the stage carries no row of identical buttons. */
export function TileOptionsSheet({ name, actions, open, onOpenChange }: { readonly name: string; readonly actions: readonly TileAction[]; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  return (
    <ChalkSheet open={open} onOpenChange={onOpenChange} title={`Options for ${name}`}>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className="chalk-menu-item"
          onClick={() => {
            onOpenChange(false);
            action.run();
          }}
        >
          {action.label}
        </button>
      ))}
    </ChalkSheet>
  );
}
