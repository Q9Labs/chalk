import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Avatar } from "../atomic/Avatar";
import { CursorArrow } from "./BoardIcon";
import { springStep, type Camera } from "./board-model";

export type RemoteCursor = { readonly participantId: string; readonly displayName: string; readonly x: number; readonly y: number; readonly occurredAt: string };

type Tracked = { x: number; y: number; vx: number; vy: number; tx: number; ty: number; movingUntil: number; lastX: number; lastY: number };

const REST_RATE = 16;
const STALE_MS = 10_000;
const NAME_HOLD_MS = 700;
const MOVING_PX_PER_SECOND = 25;
const HOVER_PX = 26;

/**
 * Remote people's cursors over the board: a rounded arrow, the Facehash and the name, in the person's colour.
 * Updates arrive about 15 times a second and unevenly, so each shown cursor is a spring chasing the newest one.
 */
export function BoardCursors({ cursorsRef, cameraRef, colorFor, hidden }: { readonly cursorsRef: MutableRefObject<Map<string, RemoteCursor>>; readonly cameraRef: MutableRefObject<Camera>; readonly colorFor: (participantId: string) => string; readonly hidden: boolean }) {
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
          state = { x: cursor.x, y: cursor.y, vx: 0, vy: 0, tx: cursor.x, ty: cursor.y, movingUntil: 0, lastX: cursor.x, lastY: cursor.y };
          tracked.current.set(id, state);
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
        const screenX = (state.x + camera.scrollX) * camera.zoom;
        const screenY = (state.y + camera.scrollY) * camera.zoom;
        const speed = Math.hypot(screenX - state.lastX, screenY - state.lastY) / Math.max(seconds, 1e-3);
        state.lastX = screenX;
        state.lastY = screenY;
        if (speed > MOVING_PX_PER_SECOND) state.movingUntil = now + NAME_HOLD_MS;
        const element = layer.current?.querySelector<HTMLElement>(`[data-cursor="${CSS.escape(id)}"]`);
        if (!element) continue;
        element.style.transform = `translate3d(${screenX}px, ${screenY}px, 0)`;
        const near = pointer.current !== null && Math.hypot(pointer.current.x - screenX, pointer.current.y - screenY) < HOVER_PX;
        element.dataset.named = String(near || now < state.movingUntil);
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
        <div key={person.id} className="chalk-board-cursor" data-cursor={person.id}>
          <CursorArrow color={colorFor(person.id)} />
          <span className="chalk-board-cursor-tag">
            <span className="chalk-board-cursor-name" style={{ background: colorFor(person.id) }}>
              {person.name.split(" ")[0]}
            </span>
            <Avatar name={person.name} size="xs" animated={false} className="chalk-board-cursor-avatar" />
          </span>
        </div>
      ))}
    </div>
  );
}
