export type WhiteboardView = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly bring: boolean;
} & ({ readonly originParticipantId: string; readonly originSequence: number; readonly originEpoch?: string } | { readonly originParticipantId?: never; readonly originSequence?: never; readonly originEpoch?: never });

export type WhiteboardViewBounds = { readonly maxCoordinate: number; readonly maxExtent: number };
