/** Rules for every screen-annotation control. They sit in the share header and use Chalk's flat theme tokens, with no blur or gloss over the shared screen. */
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
.chalk-ann-dock>*{pointer-events:auto;max-width:100%;min-width:0;}
.chalk-ann-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:var(--space-1-5);}
.chalk-ann-card,.chalk-ann-chip{background:var(--chalk-popover);color:var(--chalk-text);border:1px solid var(--chalk-line-strong);font-size:var(--type-caption);line-height:1.3;}
.chalk-hd-tools{display:flex;align-items:center;gap:var(--space-0-5);min-width:0;}
.chalk-ann-btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-1-5);flex:none;min-width:36px;height:36px;padding:0 var(--space-2);border:0;border-radius:var(--corner-lg);background:transparent;color:var(--chalk-soft-text);font:inherit;font-weight:600;white-space:nowrap;cursor:pointer;}
.chalk-ann-btn:hover:not(:disabled){background:var(--chalk-hover);}
.chalk-ann-btn[aria-pressed="true"]{background:var(--chalk-text-strong);color:var(--chalk-canvas);}
.chalk-ann-btn[data-tone="primary"]{height:34px;padding:0 14px;border-radius:var(--corner-pill);background:var(--chalk-text-strong);color:var(--chalk-canvas);}
.chalk-ann-btn[data-tone="primary"]:hover:not(:disabled){opacity:.85;}
.chalk-ann-btn:focus-visible,.chalk-ann-input:focus-visible,.chalk-hd-btn:focus-visible{outline:2px solid var(--chalk-focus);outline-offset:2px;}
.chalk-ann-btn:disabled{opacity:.45;cursor:default;}
.chalk-ann-btn[data-tone="outline"]{background:var(--chalk-raised);}
.chalk-ann-sep{flex:none;align-self:center;width:1px;height:22px;margin:0 6px;background:var(--chalk-line-strong);}
.chalk-ann-status{display:inline-flex;align-items:center;gap:var(--space-1-5);min-height:34px;padding:0 var(--space-3);font-weight:600;white-space:nowrap;color:var(--chalk-soft-text);}
.chalk-ann-badge{flex:none;display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 var(--space-1);border-radius:var(--corner-pill);background:var(--chalk-warning);color:var(--chalk-canvas);font-size:var(--type-caption);font-weight:700;}
.chalk-ann-dot{flex:none;box-sizing:content-box;width:16px;height:16px;border-radius:50%;border:var(--space-0-5) solid var(--chalk-canvas);outline:1px solid var(--chalk-line-strong);}
.chalk-ann-chip{display:inline-flex;align-items:center;gap:var(--space-1-5);min-height:32px;padding:var(--space-1) var(--space-3);border-radius:var(--corner-pill);font-weight:600;}
.chalk-ann-chip[data-tone="error"]{color:var(--chalk-danger-text);}
.chalk-ann-chip[data-tone="paused"]{color:var(--chalk-warning);}
.chalk-ann-chip svg{flex:none;}
.chalk-ann-card{display:grid;gap:var(--space-2-5);width:min(340px,100%);padding:var(--space-3) var(--space-4);border-radius:var(--corner-2xl);font-size:var(--type-body-sm);}
.chalk-ann-card p{margin:0;}
.chalk-ann-card-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2);}
.chalk-ann-textbtn{display:inline-flex;align-items:center;min-height:32px;padding:0 var(--space-1);border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer;opacity:.82;}
.chalk-ann-textbtn:hover{opacity:1;}
.chalk-ann-textbtn:focus-visible{outline:2px solid var(--chalk-focus);outline-offset:2px;border-radius:var(--corner-sm);}
.chalk-ann-code{display:block;padding:var(--space-2) var(--space-3);border-radius:var(--corner-lg);background:var(--chalk-raised);font:600 var(--type-body-sm)/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;word-break:break-all;}
.chalk-ann-field{display:grid;gap:var(--space-1);font-weight:600;}
.chalk-ann-input{height:40px;padding:0 var(--space-3);border:1px solid var(--chalk-line-strong);border-radius:var(--corner-lg);background:var(--chalk-surface);color:var(--chalk-text-strong);font:inherit;font-weight:400;letter-spacing:.08em;}
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
.chalk-ann-width{display:flex;gap:var(--space-1-5);}
.chalk-ann-width button{flex:1;display:grid;place-items:center;height:34px;border:0;border-radius:var(--corner-md);background:var(--chalk-raised);cursor:pointer;}
.chalk-ann-width button[aria-pressed="true"]{background:var(--chalk-text-strong);}
.chalk-ann-width i{display:block;width:26px;border-radius:9px;background:var(--chalk-text-strong);}
.chalk-ann-width button[aria-pressed="true"] i{background:var(--chalk-canvas);}
.chalk-ann-width button:focus-visible{outline:2px solid var(--chalk-focus);outline-offset:2px;}
.chalk-ann-stamps{display:flex;gap:var(--space-1);}
.chalk-ann-stamp{display:grid;place-items:center;width:40px;height:40px;border:0;border-radius:var(--corner-lg);background:transparent;color:var(--chalk-text);font-size:var(--type-body-lg);cursor:pointer;}
.chalk-ann-stamp:hover{background:var(--chalk-line-strong);}
.chalk-ann-stamp[aria-pressed="true"]{background:var(--chalk-text-strong);color:var(--chalk-canvas);}
.chalk-ann-stamp:focus-visible{outline:2px solid var(--chalk-focus);outline-offset:2px;}
.chalk-ann-draw,.chalk-ann-pill{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-1-5);flex:none;height:34px;padding:0 14px;border:0;border-radius:var(--corner-pill);background:var(--chalk-raised);color:var(--chalk-text);font:inherit;font-size:var(--type-caption);font-weight:600;white-space:nowrap;cursor:pointer;}
.chalk-ann-draw:hover:not([data-quiet]),.chalk-ann-pill:hover{background:var(--chalk-hover);}
.chalk-ann-draw[data-tone="solid"],.chalk-ann-pill[data-tone="solid"]{background:var(--chalk-text-strong);color:var(--chalk-canvas);}
.chalk-ann-draw[data-tone="solid"]:hover,.chalk-ann-pill[data-tone="solid"]:hover{opacity:.85;background:var(--chalk-text-strong);}
.chalk-ann-draw:focus-visible,.chalk-ann-pill:focus-visible{outline:2px solid var(--chalk-focus);outline-offset:2px;}
.chalk-ann-draw[data-quiet]{background:transparent;color:var(--chalk-soft-text);cursor:default;}
.chalk-ann-swatch{display:block;width:22px;height:22px;border-radius:50%;outline:1px solid var(--chalk-line-strong);}
.chalk-ann-stamp[aria-pressed="true"] .chalk-ann-swatch{outline:2px solid var(--chalk-canvas);outline-offset:-4px;}
.chalk-ann-title{display:flex;align-items:center;gap:var(--space-2);min-width:0;flex:1;font-weight:600;}
.chalk-ann-title>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.chalk-ann-title .chalk-ann-muted{font-weight:500;color:var(--chalk-muted-text);}
.chalk-ann-live{display:inline-flex;align-items:center;gap:var(--space-1-5);padding:4px 10px;border-radius:var(--corner-pill);background:var(--chalk-wash);color:var(--chalk-soft-text);font-weight:500;}
.chalk-ann-live i{width:7px;height:7px;border-radius:50%;background:var(--chalk-positive);}
[data-phone] .chalk-share-name:has(~ .chalk-hd-slot .chalk-hd-tools){display:none;}
@media (pointer:coarse){.chalk-ann-btn{min-width:44px;height:44px;}.chalk-ann-btn[data-tone="primary"]{height:40px;}.chalk-ann-small,.chalk-ann-textbtn,.chalk-ann-choice,.chalk-ann-pill,.chalk-ann-draw{min-height:44px;}}
@media (prefers-reduced-motion:no-preference){.chalk-ann-btn,.chalk-ann-small,.chalk-ann-stamp,.chalk-ann-pill,.chalk-ann-draw{transition:background-color .12s ease,color .12s ease;}}
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
