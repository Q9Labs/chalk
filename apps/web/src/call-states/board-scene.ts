import type { ChalkWhiteboardV1Element, ChalkWhiteboardV1Event, ChalkJsonValue } from "@q9labsai/chalk-client";

// The approved board mockup's "Launch plan" scene, drawn by Nora and Malik.
const INK = "#1b1c1f";
const NOTE_TEXT = "#1b1c1e";
const PEN = { red: "#e23240", orange: "#c15a10", green: "#288a51", blue: "#1f7ad6", violet: "#935ae2" };
const NOTE = { ink: "#f6e27a", green: "#a8dbb8", blue: "#a9cdf2" };

type Shape = { readonly id: string; readonly type: string } & Readonly<Record<string, ChalkJsonValue>>;

const base = { angle: 0, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, seed: 1, link: null, locked: false, boundElements: null, updated: 1 };

function text(id: string, x: number, y: number, value: string, size: number, color: string, extra: Record<string, ChalkJsonValue> = {}): Shape {
  const lines = value.split("\n");
  return {
    ...base,
    id,
    type: "text",
    x,
    y,
    width: Math.max(...lines.map((line) => line.length)) * size * 0.55,
    height: lines.length * size * 1.25,
    strokeColor: color,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    text: value,
    originalText: value,
    fontSize: size,
    fontFamily: 6,
    textAlign: "left",
    verticalAlign: "top",
    lineHeight: 1.25,
    autoResize: true,
    containerId: null,
    ...extra,
  };
}

function note(id: string, x: number, y: number, fill: string, label: string): Shape[] {
  return [
    { ...base, id, type: "rectangle", x, y, width: 170, height: 150, strokeColor: fill, backgroundColor: fill, fillStyle: "solid", strokeWidth: 1, roundness: { type: 3, value: 4 }, customData: { chalkNote: true }, boundElements: [{ type: "text", id: `${id}-text` }] },
    text(`${id}-text`, x + 12, y + 12, label, 18, NOTE_TEXT, { containerId: id, width: 146, autoResize: false }),
  ];
}

function stroke(id: string, x: number, y: number, color: string, points: readonly (readonly [number, number])[], width = 4.5): Shape {
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  return {
    ...base,
    id,
    type: "freedraw",
    x,
    y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    strokeColor: color,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: width / 4.25,
    roundness: null,
    points: points.map(([px, py]) => [px, py]),
    pressures: [],
    simulatePressure: true,
    lastCommittedPoint: null,
  };
}

function shape(id: string, type: "rectangle" | "ellipse", x: number, y: number, width: number, height: number, color: string): Shape {
  return { ...base, id, type, x, y, width, height, strokeColor: color, backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2.5, roundness: type === "rectangle" ? { type: 3 } : null };
}

const wave = Array.from({ length: 27 }, (_, k) => [k * 7.5, Math.sin(k / 2.2) * 5] as const);
const check = [
  [0, 0],
  [16, 18],
  [56, -34],
] as const;

const PLAN: readonly Shape[] = [
  text("title", 60, 40, "Launch plan", 40, INK),
  stroke("underline", 60, 100, PEN.orange, wave),
  ...note("note-1", 60, 150, NOTE.ink, "Pricing page copy"),
  ...note("note-2", 250, 150, NOTE.blue, "QA on iOS and\nAndroid"),
  ...note("note-3", 440, 150, NOTE.green, "Announce on\nFriday"),
  {
    ...base,
    id: "arrow",
    type: "arrow",
    x: 640,
    y: 225,
    width: 100,
    height: 0,
    strokeColor: INK,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2.5,
    roundness: null,
    points: [
      [0, 0],
      [100, 0],
    ],
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
    lastCommittedPoint: null,
  },
  shape("ship", "rectangle", 760, 140, 300, 170, PEN.violet),
  text("ship-text", 800, 205, "Ship it", 30, PEN.violet),
  shape("ring", "ellipse", 890, 150, 150, 80, PEN.red),
  shape("done", "ellipse", 60, 420, 200, 80, PEN.green),
  text("done-text", 112, 442, "Done", 28, PEN.green),
  stroke("tick", 330, 470, PEN.blue, check),
];

const INDEX = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function planScene(): ChalkWhiteboardV1Element[] {
  return PLAN.map(({ id, type, ...payload }, position) => ({ id, type, version: 1, versionNonce: position + 1, index: `a${INDEX[position]}`, isDeleted: false, payload }));
}

/** One short word, far smaller than any viewport. */
export function smallScene(): ChalkWhiteboardV1Element[] {
  return planScene().filter((element) => element.id === "done-text");
}

/** Nora and Malik move their pointers around the plan, as cursor updates about 15 times a second. */
export function boardActivity(people: readonly { readonly id: string; readonly name: string }[], emit: (event: ChalkWhiteboardV1Event) => void): () => void {
  const started = performance.now();
  const anchors = [
    { x: 330, y: 250, rx: 140, ry: 60 },
    { x: 820, y: 400, rx: 160, ry: 90 },
  ];
  const tick = () => {
    const seconds = (performance.now() - started) / 1000;
    const occurredAt = new Date().toISOString();
    people.forEach((person, index) => {
      const anchor = anchors[index % anchors.length]!;
      const phase = seconds * (0.6 + index * 0.25) + index;
      emit({ type: "cursor", participantId: person.id, displayName: person.name, x: anchor.x + Math.cos(phase) * anchor.rx, y: anchor.y + Math.sin(phase * 1.3) * anchor.ry, occurredAt });
    });
  };
  const views = () => {
    const occurredAt = new Date().toISOString();
    people.forEach((person, index) => emit({ type: "view", participantId: person.id, displayName: person.name, x: index === 0 ? 20 : 600, y: index === 0 ? 20 : 120, width: index === 0 ? 700 : 600, height: index === 0 ? 440 : 420, bring: false, occurredAt }));
  };
  const cursors = setInterval(tick, 66);
  const viewTimer = setInterval(views, 1000);
  queueMicrotask(views);
  return () => {
    clearInterval(cursors);
    clearInterval(viewTimer);
  };
}
