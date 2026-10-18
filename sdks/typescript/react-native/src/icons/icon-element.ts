type Stroke = {
  readonly strokeWidth?: number;
  /** `currentColor` fills the shape with the icon colour; otherwise shapes are stroked only. */
  readonly fill?: "currentColor";
  readonly transform?: string;
};

export type IconElement =
  | (Stroke & { readonly kind: "path"; readonly d: string })
  | (Stroke & { readonly kind: "rect"; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly rx?: number })
  | (Stroke & { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number });
