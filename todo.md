# TODO

Keep it minimal

- [ ] Design and ship Chalk iframe embeds integration.
  - Spec `/embed/rooms/:id`, embed tokens, iframe `allow` attributes, and a small `postMessage` API.
  - Start with full meeting embed, then consider minimal/dashboard mode.
- [ ] Add an opt-in Pi browser subagent broker for `pi-chrome`.
  - Keep Chrome tools and large browser outputs inside one persistent worker; return bounded findings, evidence links, screenshot paths, errors, and decisions to the parent agent.
  - Preserve explicit session authorization and use direct Chrome tools only for small one-step interactions.
