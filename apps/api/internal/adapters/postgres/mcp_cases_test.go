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
		{"inspect_tenant", `{}`, ""},
		{"set_membership", fmt.Sprintf(`{"action":"create","create":{"user_id":%q,"role":"observer"}}`, userID), ""},
		{"issue_api_key", fmt.Sprintf(`{"action":"create","request_key":"mcp-issued-key-0001","create":{"name":"MCP issued","scopes":["spaces:read"],"expires_at":%q}}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339)), ""},
		{"revoke_api_key", fmt.Sprintf(`{"api_key_id":%q}`, keyID), ""},
		{"inspect_webhooks", `{}`, ""},
		{"configure_webhook", fmt.Sprintf(`{"action":"update","endpoint_id":%q,"revision":1,"request_key":"mcp-hook-update-0001","update":{"name":"MCP updated hook"}}`, endpointID), ""},
		{"send_webhook", fmt.Sprintf(`{"action":"test","endpoint_id":%q,"request_key":"mcp-hook-test-000001"}`, endpointID), ""},
		{"inspect_spaces", `{"page_size":1}`, ""},
		{"create_space", fmt.Sprintf(`{"request_key":"mcp-space-create-001","body":{"name":"MCP created Space","slug":%q,"media_plane":"cf_sfu"}}`, accountTenantIntegrationID(t)), ""},
		{"configure_space", fmt.Sprintf(`{"action":"settings","space_id":%q,"settings":{"name":"MCP changed Space"}}`, spaceID), ""},
		{"set_space_archived", fmt.Sprintf(`{"space_id":%q,"archived":false}`, spaceID), ""},
		{"prepare_recording", fmt.Sprintf(`{"space_id":%q,"action":"prepare","starts_at":%q,"expected_revision":0}`, spaceID, time.Now().Add(time.Hour).UTC().Format(time.RFC3339)), ""},
		{"inspect_episodes", fmt.Sprintf(`{"space_id":%q}`, spaceID), ""},
		{"create_episode", fmt.Sprintf(`{"space_id":%q,"request_key":"mcp-episode-create-01","body":{}}`, emptySpace), ""},
		{"set_episode_deadline", fmt.Sprintf(`{"space_id":%q,"episode_id":%q,"request_key":"mcp-episode-deadline-01","deadline_at":%q}`, spaceID, episodeID, time.Now().Add(2*time.Hour).UTC().Format(time.RFC3339)), ""},
		{"decide_admission_request", fmt.Sprintf(`{"space_id":%q,"request_handle":"missing-request-handle","decision":"deny","request_key":"mcp-admission-deny-01"}`, spaceID), "admission_request.not_found"},
		{"remove_participant", fmt.Sprintf(`{"space_id":%q,"episode_id":%q,"participant_id":%q,"participant_generation":1,"request_key":"mcp-participant-remove-01"}`, spaceID, episodeID, participantID), ""},
		{"control_call", fmt.Sprintf(`{"action":"admit","admission":"direct","space_id":%q,"episode_id":%q,"name":"MCP agent","role":"collaborator","request_key":"mcp-call-admit-0001"}`, spaceID, episodeID), ""},
		{"end_episode", fmt.Sprintf(`{"space_id":%q,"episode_id":%q,"request_key":"mcp-episode-end-0001"}`, endSpace, endEpisode), ""},
		{"inspect_recordings", `{}`, ""},
		{"export_recording", fmt.Sprintf(`{"recording_id":%q}`, recordingID), ""},
		{"inspect_transcripts", fmt.Sprintf(`{"recording_id":%q}`, recordingID), ""},
		{"request_transcript", fmt.Sprintf(`{"recording_id":%q,"request_key":"mcp-transcript-request-01"}`, recordingID), "transcript.already_exists"},
		{"delete_transcript", fmt.Sprintf(`{"transcript_id":%q}`, transcriptID), ""},
	}
}
