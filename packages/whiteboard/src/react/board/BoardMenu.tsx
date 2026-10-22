import { Menu } from "@base-ui/react/menu";
import { ChalkMenu, ChalkMenuItem, ChalkMenuLabel } from "./controls";
import { BoardIcon } from "./BoardIcon";
import type { WhoCanDraw } from "./board-draw-policy";
import { DRAW_POLICIES, ISLAND_PLACES, SURFACES, type BoardSurface, type IslandPlace } from "./board-model";

export type BoardMenuProps = {
  readonly surface: BoardSurface;
  readonly onSurface: (surface: BoardSurface) => void;
  /** Offered outside a phone, to people who can draw. */
  readonly place?: IslandPlace;
  readonly onPlace: (place: IslandPlace) => void;
  readonly downloadLabel?: string;
  readonly onDownload: () => void;
  readonly onCopy: () => void;
  /** Offered to hosts. */
  readonly whoCanDraw?: WhoCanDraw;
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

function Check({ on }: { readonly on: boolean }) {
  return (
    <span data-part="menu-check" className="chalk-menu-check" aria-hidden="true">
      {on ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : null}
    </span>
  );
}

function PickedPeople({ people, onPick }: Pick<WhoCanDraw, "people" | "onPick">) {
  if (people.length === 0) return <p className="chalk-board-picked-note">No one else is here yet. Hosts can always draw.</p>;
  return (
    <>
      <div className="chalk-board-picked" role="group" aria-label="Picked people">
        {people.map((person) => (
          <Menu.CheckboxItem key={person.id} className="chalk-menu-item" checked={person.picked} onCheckedChange={(picked) => onPick(person.id, picked)} closeOnClick={false}>
            <Check on={person.picked} />
            <span className="chalk-board-picked-name">{person.name}</span>
          </Menu.CheckboxItem>
        ))}
      </div>
      {people.some((person) => person.picked) ? null : <p className="chalk-board-picked-note">Only hosts can draw until you pick someone.</p>}
    </>
  );
}

function WhoCanDrawSection({ policy, people, onPolicy, onPick }: WhoCanDraw) {
  return (
    <>
      <Menu.Separator className="chalk-board-menu-rule" />
      <ChalkMenuLabel>Who can draw</ChalkMenuLabel>
      {DRAW_POLICIES.map((option) => (
        <ChalkMenuItem key={option.id} checked={policy === option.id} closeOnClick={false} onClick={() => onPolicy(option.id)}>
          {option.label}
        </ChalkMenuItem>
      ))}
      {policy === "picked" ? <PickedPeople people={people} onPick={onPick} /> : null}
    </>
  );
}

/** The board's own menu: export, the person's own appearance, and the host's board actions. */
export function BoardMenu({ surface, onSurface, place, onPlace, onDownload, onCopy, whoCanDraw, onBring, onClear, onClose, downloadLabel = "Download as PNG" }: BoardMenuProps) {
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
        {downloadLabel}
      </ChalkMenuItem>
      <ChalkMenuItem onClick={onCopy}>
        <BoardIcon name="copy" size={18} />
        Copy as image
      </ChalkMenuItem>
      <Menu.Separator className="chalk-board-menu-rule" />
      <ChalkMenuLabel>Board appearance</ChalkMenuLabel>
      <Tiles label="Surface" value={surface} options={SURFACES} onChange={onSurface} preview={(id) => <SurfacePreview surface={id} />} />
      {place ? <Tiles label="Tool island" value={place} options={ISLAND_PLACES} onChange={onPlace} preview={(id) => <IslandPreview place={id} />} /> : null}
      {whoCanDraw ? <WhoCanDrawSection {...whoCanDraw} /> : null}
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
