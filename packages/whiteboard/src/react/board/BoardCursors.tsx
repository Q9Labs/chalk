import { Fragment, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ReactNode } from "react";
import { BoardIcon, CursorArrow } from "./BoardIcon";
import { springStep, type Camera, type Viewport } from "./board-model";
import { edgePointer, tagFlip, tagVisible, toScreen } from "./board-pointers";

export type RemoteCursor = { readonly participantId: string; readonly displayName: string; readonly x: number; readonly y: number; readonly occurredAt: string };

type Tracked = { name: string; x: number; y: number; vx: number; vy: number; tx: number; ty: number; tag: { width: number; height: number } | null };

const REST_RATE = 16;
const STALE_MS = 10_000;
/** Slide limits for the off-screen chips: clear of the board menu, the zoom and the island, and of the chips at the top. */
const EDGE_INSETS = { top: 56, right: 64, bottom: 80, left: 64 } as const;
const HOVER_PX = 26;
/** The name starts this far into the tag, behind the avatar, as the stylesheet has it. */
const NAME_INDENT_PX = 14;

/** Pruning belongs to receipt too: grid boards do not mount the cursor layer. */
export function rememberCursor(cursors: Map<string, RemoteCursor>, cursor: RemoteCursor): void {
  const now = Date.now();
  for (const [id, previous] of cursors) if (now - Date.parse(previous.occurredAt) > STALE_MS) cursors.delete(id);
  cursors.delete(cursor.participantId);
  if (now - Date.parse(cursor.occurredAt) <= STALE_MS) cursors.set(cursor.participantId, cursor);
  if (cursors.size > 256) {
    const oldest = cursors.keys().next().value;
    if (oldest !== undefined) cursors.delete(oldest);
  }
}

/**
 * Remote people's cursors over the board: a rounded arrow, the Facehash and the name, in the person's colour.
 * Updates arrive about 15 times a second and unevenly, so each shown cursor is a spring chasing the newest one.
 */
export function BoardCursors({
  cursorsRef,
  cameraRef,
  colorFor,
  hidden,
  renderAvatar,
}: {
  readonly cursorsRef: MutableRefObject<Map<string, RemoteCursor>>;
  readonly cameraRef: MutableRefObject<Camera>;
  readonly colorFor: (participantId: string) => string;
  readonly hidden: boolean;
  readonly renderAvatar?: (name: string) => ReactNode;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [people, setPeople] = useState<readonly { readonly id: string; readonly name: string }[]>([]);
  const tracked = useRef(new Map<string, Tracked>());
  const pointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const seconds = Math.min(0.1, (now - last) / 1000);
      last = now;
      const camera = cameraRef.current;
      const roster = cursorsRef.current;
      let rosterChanged = false;
      for (const [id, cursor] of roster) {
        if (Date.now() - Date.parse(cursor.occurredAt) > STALE_MS) {
          roster.delete(id);
          continue;
        }
        let state = tracked.current.get(id);
        if (!state) {
          state = { name: cursor.displayName, x: cursor.x, y: cursor.y, vx: 0, vy: 0, tx: cursor.x, ty: cursor.y, tag: null };
          tracked.current.set(id, state);
          rosterChanged = true;
        }
        if (state.name !== cursor.displayName) {
          state.name = cursor.displayName;
          state.tag = null;
          rosterChanged = true;
        }
        if (cursor.x !== state.tx || cursor.y !== state.ty) {
          state.tx = cursor.x;
          state.ty = cursor.y;
        }
      }
      for (const [id, state] of tracked.current) {
        if (!roster.has(id)) {
          tracked.current.delete(id);
          roster.delete(id);
          rosterChanged = true;
          continue;
        }
        const [dx, vx] = springStep(state.x - state.tx, state.vx, REST_RATE, seconds);
        const [dy, vy] = springStep(state.y - state.ty, state.vy, REST_RATE, seconds);
        state.x = state.tx + dx;
        state.y = state.ty + dy;
        state.vx = vx;
        state.vy = vy;
        const element = layer.current?.querySelector<HTMLElement>(`[data-cursor="${CSS.escape(id)}"]`);
        if (!element) continue;
        const viewport: Viewport = { width: layer.current?.clientWidth ?? 0, height: layer.current?.clientHeight ?? 0 };
        const screen = toScreen(camera, state);
        element.style.transform = `translate3d(${screen.x}px, ${screen.y}px, 0)`;
        if (!state.tag) {
          const name = element.querySelector<HTMLElement>(".chalk-board-cursor-name");
          const avatar = element.querySelector<HTMLElement>(".chalk-board-cursor-avatar");
          if (name && name.textContent === state.name.split(" ")[0]) state.tag = { width: Math.max(NAME_INDENT_PX + name.offsetWidth, avatar?.offsetWidth ?? 0), height: Math.max(name.offsetHeight, avatar?.offsetHeight ?? 0) };
        }
        const flip = state.tag ? tagFlip(screen, state.tag, viewport) : { x: false, y: false };
        element.dataset.flipX = String(flip.x);
        element.dataset.flipY = String(flip.y);
        const near = pointer.current !== null && Math.hypot(pointer.current.x - screen.x, pointer.current.y - screen.y) < HOVER_PX;
        element.dataset.named = String(tagVisible(Date.now() - Date.parse(roster.get(id)!.occurredAt), near));
        const chip = layer.current?.querySelector<HTMLElement>(`[data-edge-for="${CSS.escape(id)}"]`);
        if (!chip) continue;
        const edge = edgePointer(screen, viewport, EDGE_INSETS);
        chip.hidden = edge === null;
        if (!edge) continue;
        chip.dataset.edge = edge.edge;
        chip.style.transform = `translate3d(${edge.x}px, ${edge.y}px, 0)`;
        chip.style.setProperty("--chalk-board-edge-angle", `${edge.angle - 90}deg`);
      }
      if (rosterChanged) setPeople([...roster.values()].filter((cursor) => tracked.current.has(cursor.participantId)).map((cursor) => ({ id: cursor.participantId, name: cursor.displayName })));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [cameraRef, cursorsRef]);

  useEffect(() => {
    const board = layer.current?.parentElement;
    if (!board) return;
    const move = (event: PointerEvent) => {
      const rect = board.getBoundingClientRect();
      pointer.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const leave = () => (pointer.current = null);
    board.addEventListener("pointermove", move);
    board.addEventListener("pointerleave", leave);
    return () => {
      board.removeEventListener("pointermove", move);
      board.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <div ref={layer} className="chalk-board-cursors" aria-hidden="true" data-hidden={hidden || undefined}>
      {people.map((person) => (
        <Fragment key={person.id}>
          <div className="chalk-board-cursor" data-cursor={person.id}>
            <CursorArrow color={colorFor(person.id)} />
            <span className="chalk-board-cursor-tag">
              <span className="chalk-board-cursor-name" style={{ background: colorFor(person.id) }}>
                {person.name.split(" ")[0]}
              </span>
              {renderAvatar?.(person.name)}
            </span>
          </div>
          <div className="chalk-board-edge" data-edge-for={person.id} hidden style={{ background: colorFor(person.id) }}>
            {person.name.split(" ")[0]}
            <BoardIcon name="chevron" size={16} className="chalk-board-edge-arrow" />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
