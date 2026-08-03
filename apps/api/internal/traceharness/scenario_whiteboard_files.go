package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

const RouteWhiteboardFileUploadScenario = "route:whiteboard-file-upload"

func runRouteWhiteboardFileUpload(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	subject := whiteboardfiles.Subject{
		TenantID:              mustID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
		SpaceID:               mustID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
		EpisodeID:             mustID("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
		ParticipantID:         mustID("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
		ParticipantGeneration: 4,
	}
	body := json.RawMessage(`{
		"sceneId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		"fileId":"image-01",
		"mimeType":"image/png",
		"byteLength":128,
		"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	}`)
	handler := httpapi.NewRouter(httpapi.Options{
		RateLimit:              noRateLimits(now),
		WhiteboardFiles:        tracedWhiteboardFileService{recorder: recorder, now: now},
		WhiteboardParticipants: tracedWhiteboardParticipantVerifier{recorder: recorder, subject: subject},
	})

	return runRouteTrace(ctx, routeTraceConfig{
		Name:           RouteWhiteboardFileUploadScenario,
		Recorder:       recorder,
		Handler:        handler,
		Method:         http.MethodPost,
		Path:           "/v1/whiteboard/files/uploads",
		Body:           body,
		Authorization:  "Bearer trace-sync-participant-token",
		ExpectedStatus: http.StatusCreated,
	})
}

type tracedWhiteboardParticipantVerifier struct {
	recorder *Recorder
	subject  whiteboardfiles.Subject
}

func (v tracedWhiteboardParticipantVerifier) VerifyWhiteboardParticipant(
	_ context.Context,
	_ string,
) (whiteboardfiles.Subject, bool, error) {
	v.recorder.Add(
		"authentication",
		"whiteboard.ParticipantVerifier.VerifyWhiteboardParticipant",
		"verify participant-scoped Sync credential",
		map[string]any{
			"participant_generation": v.subject.ParticipantGeneration,
			"credential":             "[redacted]",
		},
	)
	return v.subject, true, nil
}

type tracedWhiteboardFileService struct {
	recorder *Recorder
	now      func() time.Time
}

func (s tracedWhiteboardFileService) Initiate(
	_ context.Context,
	input whiteboardfiles.InitiateInput,
) (whiteboardfiles.UploadInstructions, error) {
	s.recorder.Add(
		"application",
		"whiteboard.FileService.Initiate",
		"reserve file metadata and issue staged upload",
		map[string]any{
			"scene_id":    input.SceneID.String(),
			"file_id":     input.FileID,
			"mime_type":   input.MIMEType,
			"byte_length": input.ByteLength,
		},
	)
	return whiteboardfiles.UploadInstructions{
		UploadID:  mustID("ffffffff-ffff-4fff-8fff-ffffffffffff"),
		Method:    http.MethodPut,
		URL:       "[signed-upload-url-redacted]",
		Headers:   map[string]string{"content-type": input.MIMEType},
		ExpiresAt: s.now().Add(10 * time.Minute),
	}, nil
}

func (tracedWhiteboardFileService) Finalize(
	context.Context,
	whiteboardfiles.Subject,
	utilities.ID,
) error {
	return nil
}

func (tracedWhiteboardFileService) Download(
	context.Context,
	whiteboardfiles.Subject,
	string,
) (whiteboardfiles.Download, error) {
	return whiteboardfiles.Download{}, nil
}
