package postgres

import (
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func mcpCases(t *testing.T, spaceID, emptySpace, episodeID, participantID, recordingID, transcriptID, userID, keyID, endpointID, endSpace, endEpisode utilities.ID) []mcpToolCase {
	return []mcpToolCase{
		{"get_connection", `{}`, ""},
		{"update_tenant", `{"body":{"name":"MCP changed"}}`, ""},
		{"list_memberships", `{}`, ""},
		{"set_membership", fmt.Sprintf(`{"action":"create","create":{"user_id":%q,"role":"observer"}}`, userID), ""},
		{"list_api_keys", `{}`, ""},
		{"issue_api_key", fmt.Sprintf(`{"action":"create","request_key":"mcp-issued-key-0001","create":{"name":"MCP issued","scopes":["spaces:read"],"expires_at":%q}}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339)), ""},
		{"revoke_api_key", fmt.Sprintf(`{"api_key_id":%q}`, keyID), ""},
		{"inspect_webhooks", `{}`, ""},
		{"configure_webhook", fmt.Sprintf(`{"action":"update","endpoint_id":%q,"revision":1,"request_key":"mcp-hook-update-0001","update":{"name":"MCP updated hook"}}`, endpointID), ""},
		{"inspect_webhook_deliveries", fmt.Sprintf(`{"endpoint_id":%q}`, endpointID), ""},
		{"send_webhook", fmt.Sprintf(`{"action":"test","endpoint_id":%q,"request_key":"mcp-hook-test-000001"}`, endpointID), ""},
		{"list_space_activity", fmt.Sprintf(`{"space_ids":[%q]}`, spaceID), ""},
		{"list_spaces", `{"page_size":1}`, ""},
		{"inspect_space", fmt.Sprintf(`{"space_id":%q}`, spaceID), ""},
		{"create_space", fmt.Sprintf(`{"request_key":"mcp-space-create-001","body":{"name":"MCP created Space","slug":%q,"media_plane":"cf_sfu"}}`, accountTenantIntegrationID(t)), ""},
		{"configure_space", fmt.Sprintf(`{"action":"settings","space_id":%q,"settings":{"name":"MCP changed Space"}}`, spaceID), ""},
		{"set_space_archived", fmt.Sprintf(`{"space_id":%q,"archived":false}`, spaceID), ""},
		{"prepare_recording", fmt.Sprintf(`{"space_id":%q,"action":"prepare","starts_at":%q,"expected_revision":0}`, spaceID, time.Now().Add(time.Hour).UTC().Format(time.RFC3339)), ""},
		{"list_episodes", fmt.Sprintf(`{"space_id":%q}`, spaceID), ""},
		{"inspect_episode", fmt.Sprintf(`{"space_id":%q,"episode_id":%q}`, spaceID, episodeID), ""},
		{"create_episode", fmt.Sprintf(`{"space_id":%q,"request_key":"mcp-episode-create-01","body":{}}`, emptySpace), ""},
		{"list_live_episodes", fmt.Sprintf(`{"space_ids":[%q]}`, spaceID), ""},
		{"set_episode_deadline", fmt.Sprintf(`{"space_id":%q,"episode_id":%q,"request_key":"mcp-episode-deadline-01","deadline_at":%q}`, spaceID, episodeID, time.Now().Add(2*time.Hour).UTC().Format(time.RFC3339)), ""},
		{"list_admission_requests", fmt.Sprintf(`{"space_id":%q}`, spaceID), ""},
		{"decide_admission_request", fmt.Sprintf(`{"space_id":%q,"request_handle":"missing-request-handle","decision":"deny","request_key":"mcp-admission-deny-01"}`, spaceID), "admission_request.not_found"},
		{"remove_participant", fmt.Sprintf(`{"space_id":%q,"episode_id":%q,"participant_id":%q,"participant_generation":1,"request_key":"mcp-participant-remove-01"}`, spaceID, episodeID, participantID), ""},
		{"end_episode", fmt.Sprintf(`{"space_id":%q,"episode_id":%q,"request_key":"mcp-episode-end-0001"}`, endSpace, endEpisode), ""},
		{"list_recordings", `{}`, ""},
		{"get_recording", fmt.Sprintf(`{"recording_id":%q}`, recordingID), ""},
		{"get_recording_download", fmt.Sprintf(`{"recording_id":%q,"expires_in_seconds":60}`, recordingID), ""},
		{"export_recording", fmt.Sprintf(`{"recording_id":%q}`, recordingID), ""},
		{"list_transcripts", fmt.Sprintf(`{"recording_id":%q}`, recordingID), ""},
		{"delete_transcript", fmt.Sprintf(`{"transcript_id":%q}`, transcriptID), ""},
	}
}
