import { Menu } from "@base-ui/react/menu";
import { ChalkMenu, ChalkMenuItem, ChalkMenuLabel } from "../chalk-ui";
import { BoardIcon } from "./BoardIcon";
import { ISLAND_PLACES, SURFACES, type BoardSurface, type IslandPlace } from "./board-model";

export type BoardMenuProps = {
  readonly surface: BoardSurface;
  readonly onSurface: (surface: BoardSurface) => void;
  /** Offered outside a phone, to people who can draw. */
  readonly place?: IslandPlace;
  readonly onPlace: (place: IslandPlace) => void;
  readonly onDownload: () => void;
  readonly onCopy: () => void;
  readonly onBring?: () => void;
  readonly onClear?: () => void;
  readonly onClose?: () => void;
};

function SurfacePreview({ surface }: { readonly surface: BoardSurface }) {
  return (
    <span className="chalk-board-tile-preview" data-surface={surface} aria-hidden="true">
      {surface === "dots" ? null : (
        <svg viewBox="0 0 60 38" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M14 22c5-8 9-8 12 0s8 6 12-2 6-6 8 0" />
        </svg>
      )}
    </span>
  );
}

function IslandPreview({ place }: { readonly place: IslandPlace }) {
  return (
    <span className="chalk-board-tile-preview" data-island={place} aria-hidden="true">
      <i />
    </span>
  );
}

function Tiles<T extends string>({ label, value, options, onChange, preview }: { readonly label: string; readonly value: T; readonly options: readonly { readonly id: T; readonly label: string }[]; readonly onChange: (value: T) => void; readonly preview: (id: T) => React.ReactNode }) {
  return (
    <>
      <div className="chalk-board-menu-sublabel">{label}</div>
      <Menu.RadioGroup value={value} onValueChange={(next: T) => onChange(next)} className="chalk-board-tiles" aria-label={label}>
        {options.map((option) => (
          <Menu.RadioItem key={option.id} value={option.id} closeOnClick={false} className="chalk-board-tile">
            {preview(option.id)}
            {option.label}
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </>
  );
}

/** The board's own menu: export, the person's own appearance, and the host's board actions. */
export function BoardMenu({ surface, onSurface, place, onPlace, onDownload, onCopy, onBring, onClear, onClose }: BoardMenuProps) {
  return (
    <ChalkMenu
      className="chalk-board-menu"
      trigger={
        <button type="button" className="chalk-board-menu-button" aria-label="Board menu">
          <BoardIcon name="more" />
        </button>
      }
    >
      <ChalkMenuItem onClick={onDownload}>
        <BoardIcon name="download" size={18} />
        Download as PNG
      </ChalkMenuItem>
      <ChalkMenuItem onClick={onCopy}>
        <BoardIcon name="copy" size={18} />
        Copy as image
      </ChalkMenuItem>
      <Menu.Separator className="chalk-board-menu-rule" />
      <ChalkMenuLabel>Board appearance</ChalkMenuLabel>
      <Tiles label="Surface" value={surface} options={SURFACES} onChange={onSurface} preview={(id) => <SurfacePreview surface={id} />} />
      {place ? <Tiles label="Tool island" value={place} options={ISLAND_PLACES} onChange={onPlace} preview={(id) => <IslandPreview place={id} />} /> : null}
      {onBring || onClear ? <Menu.Separator className="chalk-board-menu-rule" /> : null}
      {onBring ? (
        <ChalkMenuItem onClick={onBring}>
          <BoardIcon name="target" size={18} />
          Bring everyone here
        </ChalkMenuItem>
      ) : null}
      {onClear ? (
        <ChalkMenuItem onClick={onClear}>
          <span className="chalk-board-danger">
            <BoardIcon name="trash" size={18} />
            Clear board
          </span>
        </ChalkMenuItem>
      ) : null}
      {onClose ? (
        <>
          <Menu.Separator className="chalk-board-menu-rule" />
          <ChalkMenuItem onClick={onClose}>
            <BoardIcon name="close" size={18} />
            Close board
          </ChalkMenuItem>
        </>
      ) : null}
    </ChalkMenu>
  );
}
