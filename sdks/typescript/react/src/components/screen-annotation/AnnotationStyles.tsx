/** Rules for every screen-annotation control. Overlay tokens stay dark in both themes, so the controls read on any shared screen. */
export function AnnotationStyles() {
  return (
    <style href="chalk-screen-annotation" precedence="default">
      {ANNOTATION_CSS}
    </style>
  );
}

const ANNOTATION_CSS = `
.chalk-ann-dock{position:absolute;inset:var(--space-2);z-index:30;pointer-events:none;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:var(--space-2);container-type:inline-size;}
.chalk-ann-dock[data-local]{justify-content:flex-start;}
@container (max-width:640px){.chalk-ann-dock:not([data-local]){inset-block-end:44px;}}
.chalk-ann-dock>*{pointer-events:auto;max-width:100%;min-width:0;}
.chalk-ann-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:var(--space-1-5);}
.chalk-ann-bar,.chalk-ann-card,.chalk-ann-chip{background:var(--chalk-overlay-strong);color:var(--chalk-on-overlay);outline:1px solid color-mix(in srgb,var(--chalk-on-overlay) 14%,transparent);box-shadow:var(--chalk-shadow);font-size:var(--type-caption);line-height:1.3;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);}
.chalk-ann-bar{display:inline-flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:var(--space-0-5);padding:var(--space-1);border-radius:var(--corner-3xl);}
.chalk-ann-btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-1-5);flex:none;min-width:36px;height:36px;padding:0 var(--space-2);border:0;border-radius:var(--corner-pill);background:transparent;color:inherit;font:inherit;font-weight:600;white-space:nowrap;cursor:pointer;}
.chalk-ann-btn:hover:not(:disabled){background:color-mix(in srgb,var(--chalk-on-overlay) 16%,transparent);}
.chalk-ann-btn[aria-pressed="true"],.chalk-ann-btn[data-tone="primary"]{background:var(--chalk-on-overlay);color:var(--chalk-overlay-strong);}
.chalk-ann-btn[aria-pressed="true"]:hover:not(:disabled),.chalk-ann-btn[data-tone="primary"]:hover:not(:disabled){background:color-mix(in srgb,var(--chalk-on-overlay) 86%,transparent);}
.chalk-ann-btn:focus-visible,.chalk-ann-input:focus-visible{outline:2px solid var(--chalk-focus);outline-offset:2px;}
.chalk-ann-btn:disabled{opacity:.45;cursor:default;}
.chalk-ann-btn[data-tone="outline"]:not(:focus-visible){outline:1px solid color-mix(in srgb,var(--chalk-on-overlay) 30%,transparent);outline-offset:-1px;}
.chalk-ann-sep{flex:none;align-self:stretch;width:1px;margin:var(--space-1-5) var(--space-0-5);background:color-mix(in srgb,var(--chalk-on-overlay) 18%,transparent);}
.chalk-ann-status{display:inline-flex;align-items:center;min-height:36px;padding:0 var(--space-3);font-weight:600;white-space:nowrap;}
.chalk-ann-badge{flex:none;display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 var(--space-1);border-radius:var(--corner-pill);background:var(--chalk-overlay-warning);color:var(--chalk-overlay-strong);font-size:var(--type-caption);font-weight:700;}
.chalk-ann-dot{flex:none;box-sizing:content-box;width:16px;height:16px;border-radius:50%;border:var(--space-0-5) solid var(--chalk-overlay-strong);outline:1px solid color-mix(in srgb,var(--chalk-on-overlay) 85%,transparent);}
.chalk-ann-chip{display:inline-flex;align-items:center;gap:var(--space-1-5);min-height:32px;padding:var(--space-1) var(--space-3);border-radius:var(--corner-pill);font-weight:600;}
.chalk-ann-chip[data-tone="error"]{color:var(--chalk-overlay-danger);}
.chalk-ann-chip[data-tone="paused"]{color:var(--chalk-overlay-warning);}
.chalk-ann-chip svg{flex:none;}
.chalk-ann-card{display:grid;gap:var(--space-2-5);width:min(340px,100%);padding:var(--space-3) var(--space-4);border-radius:var(--corner-2xl);font-size:var(--type-body-sm);}
.chalk-ann-card p{margin:0;}
.chalk-ann-card-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2);}
.chalk-ann-textbtn{display:inline-flex;align-items:center;min-height:32px;padding:0 var(--space-1);border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer;opacity:.82;}
.chalk-ann-textbtn:hover{opacity:1;}
.chalk-ann-textbtn:focus-visible{outline:2px solid var(--chalk-focus);outline-offset:2px;border-radius:var(--corner-sm);}
.chalk-ann-code{display:block;padding:var(--space-2) var(--space-3);border-radius:var(--corner-lg);background:color-mix(in srgb,var(--chalk-on-overlay) 10%,transparent);font:600 var(--type-body-sm)/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;word-break:break-all;}
.chalk-ann-field{display:grid;gap:var(--space-1);font-weight:600;}
.chalk-ann-input{height:40px;padding:0 var(--space-3);border:1px solid color-mix(in srgb,var(--chalk-on-overlay) 26%,transparent);border-radius:var(--corner-lg);background:color-mix(in srgb,var(--chalk-on-overlay) 8%,transparent);color:var(--chalk-on-overlay);font:inherit;font-weight:400;letter-spacing:.08em;}
.chalk-ann-panel{display:grid;gap:var(--space-3);width:272px;max-width:100%;padding:var(--space-1);color:var(--chalk-text);font-size:var(--type-body-sm);}
.chalk-ann-panel p,.chalk-ann-panel ul,.chalk-ann-panel fieldset{margin:0;padding:0;border:0;}
.chalk-ann-panel ul{list-style:none;display:grid;gap:var(--space-1);}
.chalk-ann-heading{font-weight:600;color:var(--chalk-text-strong);}
.chalk-ann-choice{display:flex;align-items:center;gap:var(--space-2);min-height:36px;padding:0 var(--space-2);border-radius:var(--corner-md);cursor:pointer;}
.chalk-ann-choice:hover{background:var(--chalk-line-strong);}
.chalk-ann-choice input{width:16px;height:16px;margin:0;accent-color:var(--chalk-accent);}
.chalk-ann-person{display:grid;gap:var(--space-1);padding:var(--space-1-5) var(--space-2);border-radius:var(--corner-md);background:var(--chalk-line);}
.chalk-ann-person-name{display:flex;align-items:center;gap:var(--space-1-5);min-width:0;font-weight:600;}
.chalk-ann-person-name bdi{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.chalk-ann-person-name span:last-child{flex:none;font-weight:400;color:var(--chalk-muted-text);}
.chalk-ann-person-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-3);}
.chalk-ann-small{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 var(--space-3);border:1px solid var(--chalk-line-strong);border-radius:var(--corner-pill);background:transparent;color:var(--chalk-text);font:inherit;font-weight:600;cursor:pointer;}
.chalk-ann-small:hover{background:var(--chalk-line-strong);}
.chalk-ann-small[data-tone="solid"]{border-color:transparent;background:var(--chalk-text-strong);color:var(--chalk-canvas);}
.chalk-ann-small:focus-visible,.chalk-ann-choice:has(input:focus-visible){outline:2px solid var(--chalk-focus);outline-offset:2px;}
.chalk-ann-check{display:flex;align-items:center;gap:var(--space-2);min-height:32px;}
.chalk-ann-check input{width:16px;height:16px;margin:0;accent-color:var(--chalk-accent);}
.chalk-ann-slider{display:grid;gap:var(--space-1);font-weight:600;}
.chalk-ann-slider input{width:100%;accent-color:var(--chalk-accent);}
.chalk-ann-row-between{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);}
.chalk-ann-stamps{display:flex;gap:var(--space-1);}
.chalk-ann-stamp{display:grid;place-items:center;width:40px;height:40px;border:0;border-radius:var(--corner-lg);background:transparent;color:var(--chalk-text);font-size:var(--type-body-lg);cursor:pointer;}
.chalk-ann-stamp:hover{background:var(--chalk-line-strong);}
.chalk-ann-stamp[aria-pressed="true"]{background:var(--chalk-text-strong);color:var(--chalk-canvas);}
.chalk-ann-stamp:focus-visible{outline:2px solid var(--chalk-focus);outline-offset:2px;}
.chalk-ann-draw{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2);min-height:44px;padding:0 var(--space-4);border:0;border-radius:var(--corner-pill);background:var(--chalk-overlay-strong);color:var(--chalk-on-overlay);outline:1px solid color-mix(in srgb,var(--chalk-on-overlay) 14%,transparent);box-shadow:var(--chalk-shadow);font:inherit;font-size:var(--type-body-sm);font-weight:600;white-space:nowrap;cursor:pointer;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);}
.chalk-ann-draw:hover:not([data-quiet]){background:var(--chalk-overlay-hover);}
.chalk-ann-draw:focus-visible{outline:2px solid var(--chalk-focus);outline-offset:2px;}
.chalk-ann-draw[data-quiet]{cursor:default;}
.chalk-ann-swatch{display:block;width:22px;height:22px;border-radius:50%;outline:1px solid var(--chalk-line-strong);}
.chalk-ann-stamp[aria-pressed="true"] .chalk-ann-swatch{outline:2px solid var(--chalk-canvas);outline-offset:-4px;}
.chalk-ann-pill{display:inline-flex;align-items:center;gap:var(--space-1-5);flex:none;height:32px;padding:0 var(--space-3);border:0;border-radius:var(--corner-pill);background:color-mix(in srgb,var(--chalk-on-overlay) 14%,transparent);color:var(--chalk-on-overlay);font:inherit;font-size:var(--type-caption);font-weight:600;white-space:nowrap;cursor:pointer;}
.chalk-ann-pill:hover{background:color-mix(in srgb,var(--chalk-on-overlay) 22%,transparent);}
.chalk-ann-pill[data-tone="solid"]{background:var(--chalk-on-overlay);color:var(--chalk-overlay-strong);}
.chalk-ann-pill:focus-visible{outline:2px solid var(--chalk-focus);outline-offset:2px;}
.chalk-ann-notice{display:flex;align-items:center;gap:var(--space-2);min-width:0;width:100%;padding-top:var(--space-2);border-top:1px solid color-mix(in srgb,var(--chalk-on-overlay) 14%,transparent);}
.chalk-ann-notice-text{flex:1;min-width:0;font-size:var(--type-caption);}
@media (pointer:coarse){.chalk-ann-btn{min-width:44px;height:44px;}.chalk-ann-small,.chalk-ann-textbtn,.chalk-ann-choice,.chalk-ann-pill{min-height:44px;}}
@media (prefers-reduced-motion:no-preference){.chalk-ann-btn,.chalk-ann-small,.chalk-ann-stamp,.chalk-ann-pill{transition:background-color .12s ease,color .12s ease;}}
`;

/** The Document Picture-in-Picture window has no app CSS, so it ships its own. */
export const PIP_CSS = `
html,body{margin:0;height:100%;background:var(--chalk-stage);}
.chalk-ann-pip{position:relative;width:100vw;height:100vh;overflow:hidden;background:var(--chalk-stage);color:var(--chalk-on-overlay);font:var(--type-caption)/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;}
.chalk-ann-pip video{display:block;width:100%;height:100%;object-fit:contain;}
.chalk-ann-pip-status{position:absolute;inset-block-end:var(--space-2-5);inset-inline-start:var(--space-2-5);display:inline-flex;align-items:center;gap:var(--space-1-5);min-height:28px;padding:0 var(--space-3);border-radius:var(--corner-pill);background:var(--chalk-overlay-strong);outline:1px solid color-mix(in srgb,var(--chalk-on-overlay) 14%,transparent);box-shadow:var(--chalk-shadow);font-weight:600;}
.chalk-ann-pip-status i{width:8px;height:8px;border-radius:50%;background:var(--chalk-positive);}
.chalk-ann-pip-status[data-paused] i{background:var(--chalk-overlay-warning);}
`;
