2026-03-16 14:30:57 PKT
- traced participant screen-share failure path in sdk-core
- found duplicate error emission: room-level detailed error, then manager-level generic error
- found diagnostics dropping original DOMException cause/name before copied payload
- patch plan: preserve browser cause on emitError; remove duplicate manager error; add regression coverage
