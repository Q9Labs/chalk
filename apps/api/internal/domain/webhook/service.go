package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

type Service struct {
	queries *db.Queries
}

func NewService(queries *db.Queries) *Service {
	return &Service{queries: queries}
}

// WebhookPayload represents the full webhook payload sent to tenant endpoints.
type WebhookPayload struct {
	Event        string            `json:"event"`
	Timestamp    string            `json:"timestamp"`
	Meeting      MeetingInfo       `json:"meeting"`
	Participants []ParticipantInfo `json:"participants"`
	Recording    *RecordingInfo    `json:"recording,omitempty"`
	Transcript   *TranscriptInfo   `json:"transcript,omitempty"`
	Summary      *string           `json:"summary,omitempty"`
	ActionItems  []string          `json:"action_items,omitempty"`
	Errors       []ErrorInfo       `json:"errors,omitempty"`
}

type MeetingInfo struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	StartedAt        string `json:"started_at"`
	EndedAt          string `json:"ended_at"`
	DurationSeconds  int    `json:"duration_seconds"`
	ParticipantCount int    `json:"participant_count"`
}

type ParticipantInfo struct {
	ID             string         `json:"id"`
	ExternalUserID *string        `json:"external_user_id,omitempty"`
	ExternalID     *string        `json:"external_id,omitempty"`
	DisplayName    string         `json:"display_name"`
	Role           string         `json:"role"`
	JoinedAt       string         `json:"joined_at"`
	LeftAt         *string        `json:"left_at,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
}

type RecordingInfo struct {
	ID              string `json:"id"`
	DurationSeconds int    `json:"duration_seconds"`
	SizeBytes       int64  `json:"size_bytes"`
	DownloadURL     string `json:"download_url"`
	DownloadAPI     string `json:"download_api"`
	ExpiresAt       string `json:"expires_at"`
}

type TranscriptInfo struct {
	ID        string    `json:"id"`
	Text      string    `json:"text"`
	WordCount int       `json:"word_count"`
	Language  string    `json:"language"`
	Provider  string    `json:"provider"`
	Segments  []Segment `json:"segments,omitempty"`
}

type Segment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

type ErrorInfo struct {
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// PostMeetingWebhookConfig holds webhook and post-meeting processing settings.
// Mirrors the config structure in tenants handler.
type PostMeetingWebhookConfig struct {
	Enabled            bool   `json:"enabled"`
	URL                string `json:"url,omitempty"`
	Secret             string `json:"secret,omitempty"`
	IncludeRecording   bool   `json:"include_recording"`
	IncludeTranscript  bool   `json:"include_transcript"`
	IncludeSummary     bool   `json:"include_summary"`
	IncludeActionItems bool   `json:"include_action_items"`
}

// QueueDelivery creates a webhook delivery record for processing by the worker.
func (s *Service) QueueDelivery(
	ctx context.Context,
	tenantID uuid.UUID,
	roomID uuid.UUID,
	webhookURL string,
	payload WebhookPayload,
	recordingID *uuid.UUID,
	transcriptID *uuid.UUID,
) (uuid.UUID, error) {
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return uuid.Nil, fmt.Errorf("marshal payload: %w", err)
	}

	var recID, transID pgtype.UUID
	if recordingID != nil {
		recID = pgtype.UUID{Bytes: *recordingID, Valid: true}
	}
	if transcriptID != nil {
		transID = pgtype.UUID{Bytes: *transcriptID, Valid: true}
	}

	delivery, err := s.queries.CreateWebhookDelivery(ctx, db.CreateWebhookDeliveryParams{
		TenantID:     tenantID,
		RoomID:       roomID,
		RecordingID:  recID,
		TranscriptID: transID,
		EventType:    payload.Event,
		WebhookUrl:   webhookURL,
		Payload:      payloadJSON,
	})
	if err != nil {
		return uuid.Nil, fmt.Errorf("create webhook delivery: %w", err)
	}

	return delivery.ID, nil
}

// BuildPayload constructs the webhook payload based on tenant config.
func (s *Service) BuildPayload(
	room db.Room,
	recording *db.Recording,
	transcript *db.PostMeetingTranscript,
	config PostMeetingWebhookConfig,
	presignedURL string,
	participantCount int,
	participants []db.Participant,
	errors []ErrorInfo,
) WebhookPayload {
	roomName := ""
	if room.Name != nil {
		roomName = *room.Name
	}

	var startedAt, endedAt string
	var durationSeconds int
	if room.StartedAt.Valid {
		startedAt = room.StartedAt.Time.Format(time.RFC3339)
	}
	if room.EndedAt.Valid {
		endedAt = room.EndedAt.Time.Format(time.RFC3339)
		if room.StartedAt.Valid {
			durationSeconds = int(room.EndedAt.Time.Sub(room.StartedAt.Time).Seconds())
		}
	}

	payload := WebhookPayload{
		Event:        "meeting.recording_ready",
		Timestamp:    time.Now().UTC().Format(time.RFC3339),
		Participants: buildParticipantInfos(participants),
		Meeting: MeetingInfo{
			ID:               room.ID.String(),
			Name:             roomName,
			StartedAt:        startedAt,
			EndedAt:          endedAt,
			DurationSeconds:  durationSeconds,
			ParticipantCount: participantCount,
		},
		Errors: errors,
	}

	if config.IncludeRecording && recording != nil {
		expiresAt := time.Now().Add(24 * time.Hour)
		var duration int
		if recording.DurationSeconds != nil {
			duration = int(*recording.DurationSeconds)
		}
		var size int64
		if recording.SizeBytes != nil {
			size = *recording.SizeBytes
		}
		payload.Recording = &RecordingInfo{
			ID:              recording.ID.String(),
			DurationSeconds: duration,
			SizeBytes:       size,
			DownloadURL:     presignedURL,
			DownloadAPI:     fmt.Sprintf("/api/v1/recordings/%s/download", recording.ID),
			ExpiresAt:       expiresAt.Format(time.RFC3339),
		}
	}

	if config.IncludeTranscript && transcript != nil && transcript.TranscriptText != nil {
		var segments []Segment
		if transcript.TranscriptJson != nil {
			_ = json.Unmarshal(transcript.TranscriptJson, &segments)
		}

		var wordCount int
		if transcript.WordCount != nil {
			wordCount = int(*transcript.WordCount)
		}
		var language, provider string
		if transcript.Language != nil {
			language = *transcript.Language
		}
		if transcript.Provider != nil {
			provider = *transcript.Provider
		}

		payload.Transcript = &TranscriptInfo{
			ID:        transcript.ID.String(),
			Text:      *transcript.TranscriptText,
			WordCount: wordCount,
			Language:  language,
			Provider:  provider,
			Segments:  segments,
		}
	}

	if config.IncludeSummary && transcript != nil && transcript.Summary != nil {
		payload.Summary = transcript.Summary
	}

	if config.IncludeActionItems && transcript != nil && len(transcript.ActionItems) > 0 {
		payload.ActionItems = transcript.ActionItems
	}

	return payload
}

func buildParticipantInfos(participants []db.Participant) []ParticipantInfo {
	if len(participants) == 0 {
		return []ParticipantInfo{}
	}

	infos := make([]ParticipantInfo, 0, len(participants))
	for _, participant := range participants {
		displayName := ""
		if participant.DisplayName != nil {
			displayName = *participant.DisplayName
		}

		joinedAt := ""
		if participant.JoinedAt.Valid {
			joinedAt = participant.JoinedAt.Time.Format(time.RFC3339)
		}

		var leftAt *string
		if participant.LeftAt.Valid {
			formatted := participant.LeftAt.Time.Format(time.RFC3339)
			leftAt = &formatted
		}

		metadata, externalID := decodeParticipantMetadata(participant.Metadata)

		infos = append(infos, ParticipantInfo{
			ID:             participant.ID.String(),
			ExternalUserID: participant.ExternalUserID,
			ExternalID:     externalID,
			DisplayName:    displayName,
			Role:           participant.Role,
			JoinedAt:       joinedAt,
			LeftAt:         leftAt,
			Metadata:       metadata,
		})
	}

	return infos
}

func decodeParticipantMetadata(raw []byte) (map[string]any, *string) {
	if len(raw) == 0 {
		return nil, nil
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, nil
	}
	if len(decoded) == 0 {
		return nil, nil
	}

	var externalID *string
	if value, ok := decoded["externalId"]; ok {
		if str, ok := value.(string); ok && str != "" {
			externalID = &str
		}
	}
	if externalID == nil {
		if value, ok := decoded["external_id"]; ok {
			if str, ok := value.(string); ok && str != "" {
				externalID = &str
			}
		}
	}

	return decoded, externalID
}

// GetDeliveriesByRoom returns all webhook deliveries for a room.
func (s *Service) GetDeliveriesByRoom(ctx context.Context, roomID uuid.UUID) ([]db.WebhookDelivery, error) {
	return s.queries.GetWebhookDeliveriesByRoom(ctx, roomID)
}

// GetDeliveriesByTenant returns webhook deliveries for a tenant with pagination.
func (s *Service) GetDeliveriesByTenant(ctx context.Context, tenantID uuid.UUID, limit, offset int32) ([]db.WebhookDelivery, error) {
	return s.queries.GetWebhookDeliveriesByTenant(ctx, db.GetWebhookDeliveriesByTenantParams{
		TenantID: tenantID,
		Limit:    limit,
		Offset:   offset,
	})
}
