/** Phone rules follow a narrow window, or a narrow call inside a wider window. */
export const phoneRules = (rules: string) => `@media (max-width: 640px) {${rules}}
@container chalk-call (max-width: 640px) {${rules}}`;

/** The dock, menus and sheets on a phone, in the place the shell stylesheet had them. */
export const PHONE_DOCK_CSS = phoneRules(`
  .chalk-shell-details-heading {display:none;}
  .chalk-shell-detail-action,.chalk-invite-link,.chalk-details-row {min-height:48px;}
  .chalk-shell-diagnostics-copy .chalk-copy {height:44px;}
  .chalk-shell-dock .chalk-shell-leave {margin-inline-start:0;}
  .chalk-shell-dock {
    height: 52px;
    justify-content: space-between;
    gap: 0;
    padding-inline: var(--space-6);
  }
  .chalk-frame-dock .chalk-shell-dock {width:calc(100% + var(--space-6) * 2);margin-inline:calc(var(--space-6) * -1);}
  .chalk-shell-dock .chalk-shell-desktop,
  .chalk-shell-corner {
    display: none;
  }
  .chalk-shell-phone {
    display: contents;
  }
  .chalk-shell-split {
    height: 52px;
    background: none !important;
    box-shadow: none;
  }
  [data-chalk-theme="light"] .chalk-shell-split {box-shadow: var(--elevation-hairline);}
  .chalk-shell-split .chalk-shell-main {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    padding: 0;
    background: var(--chalk-raised);
  }
  .chalk-shell-split .chalk-shell-caret {
    display: none;
  }
  .chalk-shell-dock .chalk-icon-button {
    width: 52px;
    height: 52px;
  }
  .chalk-shell-modal {
    top: auto;
    bottom: 0;
    left: 0;
    translate: none;
    transform: none;
    width: 100%;
    max-width: none;
    border-radius: var(--corner-3xl) var(--corner-3xl) 0 0;
    padding-bottom: var(--space-10);
  }
  .chalk-shell-detail-action {
    min-height: 48px;
  }
`);
