package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const RouteChatAttachmentUploadScenario = "route:chat-attachment-upload"

func runRouteChatAttachmentUpload(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	subject := chatattachments.Subject{
		TenantID:              mustID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
		SpaceID:               mustID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
		EpisodeID:             mustID("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
		ParticipantID:         mustID("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
		ParticipantGeneration: 4,
	}
	body := json.RawMessage(`{
		"clientAttachmentId":"chat-file-client-0001",
		"fileName":"diagram.png",
		"mimeType":"image/png",
		"byteLength":128,
		"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	}`)
	handler := httpapi.NewRouter(httpapi.Options{
		RateLimit:       noRateLimits(now),
		ChatAttachments: tracedChatAttachmentService{recorder: recorder, now: now},
		ChatParticipants: tracedChatParticipantVerifier{
			recorder: recorder,
			subject:  subject,
		},
	})

	return runRouteTrace(ctx, routeTraceConfig{
		Name:           RouteChatAttachmentUploadScenario,
		Recorder:       recorder,
		Handler:        handler,
		Method:         http.MethodPost,
		Path:           "/v1/chat/attachments/uploads",
		Body:           body,
		Authorization:  "Bearer trace-sync-participant-token",
		ExpectedStatus: http.StatusCreated,
	})
}

type tracedChatParticipantVerifier struct {
	recorder *Recorder
	subject  chatattachments.Subject
}

func (v tracedChatParticipantVerifier) VerifyChatParticipant(
	_ context.Context,
	_ string,
) (chatattachments.Subject, bool, error) {
	v.recorder.Add(
		"authentication",
		"chatattachments.ParticipantVerifier.VerifyChatParticipant",
		"verify participant-scoped Sync credential",
		map[string]any{
			"participant_generation": v.subject.ParticipantGeneration,
			"credential":             "[redacted]",
		},
	)
	return v.subject, true, nil
}

type tracedChatAttachmentService struct {
	recorder *Recorder
	now      func() time.Time
}

func (s tracedChatAttachmentService) Initiate(
	_ context.Context,
	input chatattachments.InitiateInput,
) (chatattachments.UploadInstructions, error) {
	s.recorder.Add(
		"application",
		"chatattachments.Service.Initiate",
		"reserve attachment metadata and issue immutable upload",
		map[string]any{
			"client_attachment_id": input.ClientAttachmentID,
			"mime_type":            input.MIMEType,
			"byte_length":          input.ByteLength,
		},
	)
	return chatattachments.UploadInstructions{
		AttachmentID: mustID("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
		UploadID:     mustID("ffffffff-ffff-4fff-8fff-ffffffffffff"),
		Method:       http.MethodPut,
		URL:          "[signed-upload-url-redacted]",
		Headers:      map[string]string{"content-type": input.MIMEType},
		ExpiresAt:    s.now().Add(10 * time.Minute),
	}, nil
}

func (tracedChatAttachmentService) Finalize(
	context.Context,
	chatattachments.Subject,
	utilities.ID,
) (chatattachments.Attachment, error) {
	return chatattachments.Attachment{}, nil
}

func (tracedChatAttachmentService) Download(
	context.Context,
	chatattachments.Subject,
	utilities.ID,
) (chatattachments.Download, error) {
	return chatattachments.Download{}, nil
}
