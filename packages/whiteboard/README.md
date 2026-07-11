# @q9labsai/chalk-whiteboard

Reusable Chalk whiteboard behavior for SDKs and first-party applications.

- `@q9labsai/chalk-whiteboard` exports framework-neutral whiteboard contracts.
- `@q9labsai/chalk-whiteboard/collab` exports the Excalidraw collaboration and
  file synchronization engine.
- `@q9labsai/chalk-whiteboard/react` exports `WhiteboardCanvas`, math authoring,
  and React-facing whiteboard types.

`WhiteboardCanvas` owns Excalidraw loading, collaboration lifecycle, cursor and
scene updates, file synchronization, and math elements. Its `classNames` and
`icons` props let each surface provide presentation without reimplementing that
behavior. `@q9labsai/chalk-react` supplies Chalk's styled `WhiteboardPanel` as a
thin wrapper around this component.
