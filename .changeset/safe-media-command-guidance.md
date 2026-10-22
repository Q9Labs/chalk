---
"@q9labsai/chalk-react": patch
---

Show safe, source-aware guidance for media command failures across call controls,
keyboard shortcuts, screen sharing, and media request dialogs. Preserve the
existing onCommandError MediaSource argument and provide extended media context
in an optional third argument. Keep disable-failure wording neutral and explain
unsupported speaker selection without suggesting a retry. Preserve start/stop
intent in failure guidance and retries; show terminal guidance for withdrawn
media requests and other non-recoverable failures.
