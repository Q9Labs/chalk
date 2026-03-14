2026-03-15 01:26:02 PKT
- Scoped local follow-up to portal/theme propagation after host CSS leakage repros in consumer shells.
- Added explicit Chalk theme propagation to portaled dialog/tooltip/select/menu/combobox surfaces in `packages/sdk-react` and `packages/ui`.
- Kept unrelated `sdk-react-native`, participant-color extraction, and mobile native worktree changes untouched.
- Verified local demo at `http://localhost:3072/demo`: prejoin loaded, settings dialog + select dropdown rendered with Chalk dark styling, screenshot at `/tmp/chalk-agent-browser/screenshot-1773519921942.png`.
