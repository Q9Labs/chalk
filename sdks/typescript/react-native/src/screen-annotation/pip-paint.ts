import { paintAnnotation, type AnnotationCanvasContext, type AnnotationPresence, type AnnotationRect } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationState } from "@q9labsai/chalk-client";

type PathPart = readonly ["move" | "line", number, number] | readonly ["arc", number, number, number, number, number] | readonly ["ellipse" | "rect", number, number, number, number] | readonly ["close"];

type Paint = readonly ["fill", string, number, readonly PathPart[]] | readonly ["stroke", string, number, readonly PathPart[], number, string] | readonly ["text", string, number, string, number, number, number];

/** Record the shared painter's vector output for Core Graphics, without a background WebView. */
class PiPCanvas implements AnnotationCanvasContext {
  readonly operations: Paint[] = [];
  private path: PathPart[] = [];
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  lineWidth = 1;
  lineCap = "round";
  lineJoin = "round";
  fillStyle = "#fff";
  strokeStyle = "#fff";
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  font = "";
  textBaseline = "middle";
  textAlign = "left";

  // The shared painter scopes one full-frame clip; the native bitmap already clips to it.
  save() {}
  restore() {}
  clip() {}
  setLineDash() {}

  beginPath() {
    this.path = [];
  }
  closePath() {
    this.path.push(["close"]);
  }
  moveTo(x: number, y: number) {
    this.path.push(["move", x, y]);
  }
  lineTo(x: number, y: number) {
    this.path.push(["line", x, y]);
  }
  arc(x: number, y: number, radius: number, start: number, end: number) {
    this.path.push(["arc", x, y, radius, start, end]);
  }
  ellipse(x: number, y: number, rx: number, ry: number) {
    this.path.push(["ellipse", x - rx, y - ry, 2 * rx, 2 * ry]);
  }
  rect(x: number, y: number, width: number, height: number) {
    this.path.push(["rect", x, y, width, height]);
  }
  fill() {
    this.operations.push(["fill", this.fillStyle, this.globalAlpha, [...this.path]]);
  }
  stroke() {
    this.operations.push(["stroke", this.strokeStyle, this.globalAlpha, [...this.path], this.lineWidth, this.lineCap]);
  }
  fillText(text: string, x: number, y: number) {
    this.operations.push(["text", this.fillStyle, this.globalAlpha, text, x, y, this.fontSize]);
  }
  measureText(text: string) {
    // Reserve enough room for the native system font, including wide characters.
    const width = Array.from(text).reduce((sum, char) => sum + (char.charCodeAt(0) < 128 ? 0.7 : 1), 0);
    return { width: this.fontSize * width };
  }
  private get fontSize() {
    return Number(/([\d.]+)px/.exec(this.font)?.[1]) || 11;
  }
}

export function paintAnnotationPiP(rect: AnnotationRect, state: ScreenAnnotationState, presence: readonly AnnotationPresence[], nowMs: number) {
  const canvas = new PiPCanvas();
  paintAnnotation(canvas, { rect, sharerId: state.layer.sharer_id, paused: state.paused, marks: state.marks, presence, nowMs });
  return canvas.operations;
}
