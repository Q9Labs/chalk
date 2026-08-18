type IllustrationProps = Readonly<{
  className?: string;
  height: number;
  priority?: boolean;
  src: string;
  width: number;
}>;

// Landing illustrations support claims that remain available as real text and
// UI, so they stay decorative instead of forcing an abstract scene through a
// screen reader.
export function Illustration({ className, height, priority = false, src, width }: IllustrationProps) {
  return <img aria-hidden="true" alt="" className={className} decoding="async" fetchPriority={priority ? "high" : undefined} height={height} loading={priority ? "eager" : "lazy"} src={src} width={width} />;
}
