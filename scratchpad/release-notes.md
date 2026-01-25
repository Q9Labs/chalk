<!-- image: chalk-miscellaneous/Gemini_Generated_Image_sdmqjnsdmqjnsdmq.png -->

<!-- whats-new -->
## Bug Fixes

- **Reactions now display properly** — Fixed `activeReactions` from `useInteractions` hook not being rendered in the meeting room
- **Sound effects now play** — Enabled `autoSubscribe` by default and added missing reaction event listener
- **SSR compatibility** — Fixed ReactionPicker crash during server-side rendering in Next.js
<!-- /whats-new -->

## Technical Notes

- Added proper dependency caching to GitHub Actions CI workflow
- Cache `~/.bun/install/cache` and `node_modules` directories
- Expected CI improvement: 3.4 min → ~20-30 seconds on cache hits
