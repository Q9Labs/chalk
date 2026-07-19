# Remove Railway MCP session log

- 2026-07-19 13:31 Asia/Karachi — Located the active Railway MCP registration in `/Users/macmini/.codex/config.toml` under `[mcp_servers.railway]`.
- 2026-07-19 13:31 Asia/Karachi — Removed that Codex registration and verified the active Codex config no longer contains `mcp_servers.railway`.
- 2026-07-19 13:34 Asia/Karachi — Removed the remaining Cursor Railway MCP registration from `/Users/macmini/.cursor/mcp.json`.
- 2026-07-19 13:37 Asia/Karachi — Removed Claude Code’s Railway MCP registration from `/Users/macmini/.claude.json`.
- 2026-07-19 13:41 Asia/Karachi — Moved the Railway skill copies out of Claude, Codex, OpenCode, and Cursor into the recoverable archive `/Users/macmini/.Trash/railway-skills-20260719`, preserving only `/Users/macmini/.agents/skills/use-railway`.
- 2026-07-19 13:48 Asia/Karachi — Added `railwayapp/railway-skills/use-railway` to Skillbox’s installed registry, then moved the old `~/.agents/skills/use-railway` copy to `/Users/macmini/.Trash/railway-skill-agents-20260719`.
- 2026-07-19 13:52 Asia/Karachi — Promoted `use-railway` to Skillbox’s trusted global registry under the `cloud` category; the installed external registry is now empty and `skillbox info use-railway` reports `source: global`.
- 2026-07-19 14:02 Asia/Karachi — Repaired the promoted registry description, which had been serialized as the literal `>` marker; `skillbox info use-railway` now displays the full Railway description.
