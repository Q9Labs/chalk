## 2026-02-24 06:02:02Z
- task: re-enable whisper-worker on lean prod
- context gathered: lean currently has whisper disabled; worker code and module still exist
- next: implement lean whisper infra + workflow alignment, then validate deploy health

## 2026-02-24 06:06:59Z
- implemented: new module infrastructure/terraform/modules/ec2-whisper-lean (instance, IAM, user-data, systemd worker)
- wired: prod-lean env vars/module/outputs + infra-lean workflow validation paths
- updated: whisper-worker workflow to push to lean repo + SSM restart hook
- validation: terraform validate passed for ec2-whisper-lean and ec2-api-lean modules
- note: detected unrelated concurrent worktree changes in other files; pausing for user direction before commit/apply

## 2026-02-24 06:07:06Z
- implemented: new module infrastructure/terraform/modules/ec2-whisper-lean (instance, IAM, user-data, systemd worker)
- wired: prod-lean env vars/module/outputs + infra-lean workflow validation paths
- updated: whisper-worker workflow to push to lean repo + SSM restart hook
- validation: terraform validate passed for ec2-whisper-lean and ec2-api-lean modules
- note: detected unrelated concurrent worktree changes in other files; pausing for user direction before commit/apply

## 2026-02-24 06:09:25Z
- continue per user approval: scope-only commit/apply for whisper + lean infra
- validate: prod-lean terraform validate passed (isolated TF_DATA_DIR backend=false)
- next: commit scoped changes, push, run infra-lean apply, run whisper-worker build, verify instance+service+queue path

## 2026-02-24 06:20:25Z
- workflows: whisper-worker run 22338959512 success; infra-lean apply run 22339004983 success
- aws verify: whisper instance i-0c455e84d2d7a8095 running (c7i.large), api instance i-0d14d86a6fe48a3eb running (t4g.micro)
- whisper health: systemd active; container chalk-whisper-worker up and healthy; startup logs show model load complete + worker.start + queue depth metric
- api fix: POST_MEETING_WHISPER_ENABLED SSM value already true, but live api container had stale false env; restarted chalk-api service to reload env
- api health: POST_MEETING_WHISPER_ENABLED=true in running container; /health returns healthy with database connected
- status: lean prod green and post-meeting whisper path restored

## 2026-02-24 19:33:00Z
- task: investigate intermittent TH LMS "Failed to fetch" near 20:53 PKT and harden observability
- findings: chalk API join and ws upgrade succeeded around incident; later ws auth failure reason=missing_room_id for same client/origin
- implemented: websocket handler now logs token_source + room query diagnostics + claim/query mismatch warnings + richer auth_failed context in existing `chalk-api-prod` stream
- verify: go test ./internal/interfaces/http/handlers -run WebSocket (pass); go test ./... (pass); monorepo lint/typecheck pass; monorepo tests fail in sdk-react unrelated pre-existing failures

## 2026-03-05 08:31:27Z
- task: sdk-react quality pass for full components
- completed: split PreJoinLobby into prejoin-lobby module set; reduced main file to orchestration shell
- completed: split MeetingRoom into meeting-room module set (types/hooks/render sections); reduced main file from 916 LOC to 224 LOC
- formatting: fixed oxfmt config (`printWidth` 360 -> 300) and formatted touched files
- verify: `bun run --filter @q9labs/chalk-react check-types` pass; `bun run --filter @q9labs/chalk-react test` pass (233 pass, 3 skip, 0 fail)

## 2026-03-05 08:44:25Z
- task: continue same quality pass on sdk-react VideoConference
- completed: reduced `VideoConference.tsx` to facade (43 LOC) and moved orchestration to `useVideoConferenceController`
- completed: extracted meeting-room prop composition into `useVideoConferenceMeetingRoomProps` and view prop shaping into `view-state`
- verify: `bun run --filter @q9labs/chalk-react check-types` pass; `bun run --filter @q9labs/chalk-react test` pass (233 pass, 3 skip, 0 fail)

## 2026-03-05 09:40:56Z
- task: start prioritized refactor queue items 1-4 (phase A)
- completed: item #1 WhiteboardPanel first pass
- changes: extracted whiteboard runtime into `whiteboard-panel` modules (`constants`, `icons`, `types`, `useWhiteboardExcalidrawMount`, `useWhiteboardSync`); reduced panel file complexity by separating orchestration from UI shell
- verify: `bun run --filter @q9labs/chalk-react lint` pass (no linter configured), `check-types` pass, `test` pass (233 pass, 3 skip, 0 fail)
- queue: #2 `useJoinFlow`, #3 `useSessionEvents`, #4 `EndScreen` still active

## 2026-03-05 09:52:29Z
- task: complete queue items #2-#4 in sdk-react refactor tracker
- completed: `useJoinFlow` split into orchestration + helper modules (`useJoinFlowTelemetry`, `useRealtimeKitPreload`, `join-flow-device-tasks`)
- completed: `useSessionEvents` simplified with extracted error utils (`session-events-error-utils`)
- completed: `EndScreen` decomposed into `end-screen` section modules (`feedback`, `downloads`, `actions`, `formatDuration`, feedback hook)
- verify: `lint` pass (no linter configured), `check-types` pass, `test` pass (`233 pass, 3 skip, 0 fail`)
- tracker: items #1-#4 now done; #5-#6 remain pending approval

## 2026-03-05 16:53:24 PKT
- task: complete tracker items #5-#6 with breaking naming cleanup + event API redesign
- completed: `sdk-core` naming migration to session-centric vocabulary (`ConferenceClient`, `ConferenceSession`, `SessionInfo`, `SessionConnectionState`, `JoinSessionConfig`, `joinSession/createSession/endSession`)
- completed: `ConferenceSessionEvents` switched to dot notation (`participant.joined`, `connection.state.changed`, `chat.message`, `whiteboard.*`, etc.) with listeners updated across managers/effect services/ChalkSession bridges/tests
- completed: `sdk-react` and `sdk-react-native` re-exports/providers/hooks aligned to renamed core API
- verify: `@q9labs/chalk-core` lint/check-types/test pass; `@q9labs/chalk-react` lint/check-types/test pass; `@q9labs/chalk-react-native` lint/check-types/test pass
- tracker: items #1-#6 now complete
