/**
 * Screen annotation entity types for Chalk SDK
 *
 * Geometry is normalized to the visible shared-content rect.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */

export type AnnotationAccessMode = "all" | "sharer_only" | "off";
export type ScreenAnnotationAccessMode = AnnotationAccessMode;

export type ScreenAnnotationShape =
  | "rectangle"
  | "ellipse"
  | "line"
  | "arrow";

export type ScreenAnnotationShapeKind = ScreenAnnotationShape;

export type ScreenAnnotationTool =
  | "pen"
  | "highlighter"
  | ScreenAnnotationShape
  | "text";

export interface ScreenAnnotationPoint {
  x: number;
  y: number;
}

export interface ScreenAnnotationStyle {
  color: string;
  strokeWidth: number;
  opacity?: number;
}

interface ScreenAnnotationItemBase {
  id: string;
  type: "freehand" | "shape" | "text";
  authorParticipantId: string;
  createdAtMs: number;
  updatedAtMs: number;
  version: number;
  deleted?: boolean;
}

export interface ScreenAnnotationFreehandItem extends ScreenAnnotationItemBase {
  type: "freehand";
  tool: "pen" | "highlighter";
  style: ScreenAnnotationStyle;
  points: ScreenAnnotationPoint[];
}

export interface ScreenAnnotationShapeItem extends ScreenAnnotationItemBase {
  type: "shape";
  shape: ScreenAnnotationShape;
  style: ScreenAnnotationStyle;
  start: ScreenAnnotationPoint;
  end: ScreenAnnotationPoint;
}

export interface ScreenAnnotationTextItem extends ScreenAnnotationItemBase {
  type: "text";
  style: ScreenAnnotationStyle & {
    fontSize: number;
  };
  position: ScreenAnnotationPoint;
  text: string;
}

export type ScreenAnnotationItem =
  | ScreenAnnotationFreehandItem
  | ScreenAnnotationShapeItem
  | ScreenAnnotationTextItem;

export interface ScreenAnnotationCursor {
  shareSessionId: string;
  participantId: string;
  displayName: string;
  tool: ScreenAnnotationTool;
  x: number;
  y: number;
  timestamp: Date;
}

export interface ScreenAnnotationSession {
  shareSessionId: string;
  sharerParticipantId: string;
  accessMode: AnnotationAccessMode;
}

export interface ScreenAnnotationSessionStarted
  extends ScreenAnnotationSession {}

export interface ScreenAnnotationSessionEnded {
  shareSessionId: string;
  endedAt: Date;
}

export interface ScreenAnnotationSnapshot extends ScreenAnnotationSession {
  roomId: string;
  items: ScreenAnnotationItem[];
  updatedAtMs?: number;
  lastSeq: number;
}

export interface ScreenAnnotationUpdate {
  shareSessionId: string;
  sharerParticipantId: string;
  participantId: string;
  displayName: string;
  syncAll: boolean;
  items: ScreenAnnotationItem[];
  seq: number;
  timestamp: Date;
}

export interface ScreenAnnotationAccessChange {
  shareSessionId: string;
  accessMode: AnnotationAccessMode;
  changedBy: string;
  timestamp: Date;
}

export type ScreenAnnotationAccessChanged = ScreenAnnotationAccessChange;
