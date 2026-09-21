package httpapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTranscriptDocumentEndpointReadsCompletedArtifactAfterAuthorization(t *testing.T) {
	tenantID := documentTestID(t, "11111111-1111-4111-8111-111111111111")
	transcriptID := documentTestID(t, "22222222-2222-4222-8222-222222222222")
	recordingID := documentTestID(t, "33333333-3333-4333-8333-333333333333")
	episodeID := documentTestID(t, "44444444-4444-4444-8444-444444444444")
	artifactKey := "tenants/tenant-1/recordings/recording-1/transcripts/transcript-1/transcript.json"
	artifactType := "application/json"
	body := []byte(validHTTPDocumentJSON)
	artifactSize := int64(len(body))
	sourceExpiredAt := time.Now().Add(-time.Hour)
	service := documentTranscriptServiceStub{transcript: transcripts.Transcript{
		ID:                  transcriptID,
		TenantID:            tenantID,
		RecordingID:         recordingID,
		EpisodeID:           episodeID,
		Status:              transcripts.StatusComplete,
		ArtifactKey:         &artifactKey,
		ArtifactSize:        &artifactSize,
		ArtifactContentType: &artifactType,
		SourceExpiresAt:     &sourceExpiredAt,
	}}
	objects := documentObjectServiceStub{object: objectstorage.ObjectReader{Object: objectstorage.Object{Key: artifactKey, Size: artifactSize, ContentType: artifactType}, Body: io.NopCloser(bytes.NewReader(body))}}
	authorizer := &documentAuthorizer{}
	endpoint := transcriptDocumentEndpoint(service, &objects, authorizer)
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser})

	response, err := endpoint.handle(ctx, transcriptDocumentRequest{TenantID: tenantID, TranscriptID: transcriptID})
	if err != nil {
		t.Fatalf("handle() error = %v", err)
	}
	if authorizer.permission != (authorization.TenantPermission{Scope: authentication.ScopeTranscriptionsRead, MinimumRole: memberships.RoleObserver}) {
		t.Fatalf("authorization permission = %#v", authorizer.permission)
	}
	if response.SchemaVersion != "transcript.v1" || response.TranscriptID != transcriptID.String() || response.RecordingID != recordingID.String() || response.EpisodeID != episodeID.String() || len(response.Cues) != 1 {
		t.Fatalf("response = %#v", response)
	}
	cue := response.Cues[0]
	if cue.StartMS != 120 || cue.EndMS != 480 || cue.Text != "Cobalt marker" || !cue.Overlap || cue.Identity == nil || cue.Identity.ParticipantRef != "participant-1" || cue.Identity.ParticipantGeneration != 2 || cue.Identity.TrackID != "track-1" || cue.Identity.TrackEpoch != "epoch-1" || cue.Identity.DisplayName == nil || *cue.Identity.DisplayName != "Speaker One" {
		t.Fatalf("cue = %#v", cue)
	}
}

func TestTranscriptDocumentEndpointRejectsUnavailableArtifactBeforeObjectRead(t *testing.T) {
	tenantID := documentTestID(t, "11111111-1111-4111-8111-111111111111")
	transcriptID := documentTestID(t, "22222222-2222-4222-8222-222222222222")
	artifactKey := "tenants/tenant-1/recordings/recording-1/transcripts/transcript-1/transcript.json"
	artifactType := "application/json"
	artifactSize := transcripts.MaxDocumentBytes + 1
	objects := documentObjectServiceStub{getErr: errors.New("object read must not run")}
	endpoint := transcriptDocumentEndpoint(documentTranscriptServiceStub{transcript: transcripts.Transcript{
		ID:                  transcriptID,
		TenantID:            tenantID,
		Status:              transcripts.StatusComplete,
		ArtifactKey:         &artifactKey,
		ArtifactSize:        &artifactSize,
		ArtifactContentType: &artifactType,
	}}, &objects, &documentAuthorizer{})
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser})

	_, err := endpoint.handle(ctx, transcriptDocumentRequest{TenantID: tenantID, TranscriptID: transcriptID})
	if !errors.Is(err, apiErrorTranscriptNotReady) {
		t.Fatalf("handle() error = %v, want transcript not ready", err)
	}
	if objects.calls != 0 {
		t.Fatalf("object reads = %d, want 0", objects.calls)
	}
}

type documentTranscriptServiceStub struct {
	TranscriptArtifactService
	transcript transcripts.Transcript
	err        error
}

func (s documentTranscriptServiceStub) Get(context.Context, utilities.ID, utilities.ID) (transcripts.Transcript, error) {
	return s.transcript, s.err
}

type documentObjectServiceStub struct {
	object objectstorage.ObjectReader
	getErr error
	calls  int
}

func (s *documentObjectServiceStub) GetObject(context.Context, string) (objectstorage.ObjectReader, error) {
	s.calls++
	return s.object, s.getErr
}

type documentAuthorizer struct {
	permission authorization.TenantPermission
	err        error
}

func (a *documentAuthorizer) AuthorizeTenant(_ context.Context, _ authentication.Principal, _ utilities.ID, permission authorization.TenantPermission) error {
	a.permission = permission
	return a.err
}

func documentTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("ParseID(%q): %v", value, err)
	}
	return id
}

const validHTTPDocumentJSON = `{"schemaVersion":"transcript.v1","jobId":"job-1","episodeId":"episode-1","cues":[{"startMs":120,"endMs":480,"identity":{"kind":"participant","participantRef":"participant-1","participantGeneration":2,"trackId":"track-1","trackEpoch":"epoch-1"},"trackClass":"microphone","displayNameSnapshot":"Speaker One","text":"Cobalt marker","overlap":true,"provider":"deepinfra","model":"openai/whisper-large-v3-turbo","versionContract":"deepinfra-native-whisper-turbo.v1","attempt":1}],"provider":"deepinfra","model":"openai/whisper-large-v3-turbo","versionContract":"deepinfra-native-whisper-turbo.v1","attempt":1,"measuredAudioMs":360}`
