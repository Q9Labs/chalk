/** The slash and startup trace for the microphone and camera glyph. Kept separate so a pre-join step does not download the whole call shell. */
export const MEDIA_GLYPH_CSS = `.chalk-shell-media-body {
  opacity: 1;
  transition: opacity 0.12s ease-out;
}
.chalk-shell-media-cut,
.chalk-shell-media-slash {
  stroke-dasharray: 1 1;
  stroke-dashoffset: 1;
  opacity: 0;
  transition: stroke-dashoffset 0.18s cubic-bezier(0.2, 0.7, 0.2, 1), opacity 0s 0.18s;
}
.chalk-shell-media[data-slashed="true"] .chalk-shell-media-cut,
.chalk-shell-media[data-slashed="true"] .chalk-shell-media-slash {
  stroke-dashoffset: 0;
  opacity: 1;
  transition: stroke-dashoffset 0.18s cubic-bezier(0.2, 0.7, 0.2, 1), opacity 0s;
}
.chalk-shell-media-trace {
  opacity: 0;
  stroke-dasharray: 0.24 0.76;
  transition: opacity 0.12s ease-out;
}
.chalk-shell-media[data-busy="true"] .chalk-shell-media-body {
  opacity: 0.4;
}
.chalk-shell-media[data-busy="true"] .chalk-shell-media-trace {
  opacity: 1;
  animation: chalk-shell-trace 1.1s linear infinite;
}
@keyframes chalk-shell-trace {
  to {stroke-dashoffset: -1;}
}`;

export const MEDIA_GLYPH_REDUCED_CSS = `.chalk-shell-media-body,
  .chalk-shell-media-cut,
  .chalk-shell-media-slash,
  .chalk-shell-media-trace {
    transition: none;
  }
  .chalk-shell-media[data-busy="true"] .chalk-shell-media-trace {
    animation: none;
    opacity: 0;
  }`;
