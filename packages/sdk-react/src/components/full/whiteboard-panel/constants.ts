const CURSOR_COLORS = [
  { stroke: "#FF5D5D", background: "rgba(255, 93, 93, 0.2)" },
  { stroke: "#4CB9FF", background: "rgba(76, 185, 255, 0.2)" },
  { stroke: "#8B5CF6", background: "rgba(139, 92, 246, 0.2)" },
  { stroke: "#10B981", background: "rgba(16, 185, 129, 0.2)" },
  { stroke: "#F59E0B", background: "rgba(245, 158, 11, 0.2)" },
  { stroke: "#EC4899", background: "rgba(236, 72, 153, 0.2)" },
  { stroke: "#22D3EE", background: "rgba(34, 211, 238, 0.2)" },
  { stroke: "#A3E635", background: "rgba(163, 230, 53, 0.2)" },
];

export const CURSOR_STALE_MS = 10000;
export const EXCALIDRAW_CSS_CDN = "https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.0/dist/prod/index.css";

export function getCursorColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % CURSOR_COLORS.length;
  return CURSOR_COLORS[index];
}
