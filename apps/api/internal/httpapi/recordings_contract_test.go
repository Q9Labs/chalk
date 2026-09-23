package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecordingRouteContractsHaveNoPublicMaterializationPath(t *testing.T) {
	want := map[string]struct{}{
		"listRecordings":             {},
		"getRecording":               {},
		"createRecordingDownloadURL": {},
		"requestRecordingExport":     {},
	}

	for _, endpoint := range recordingEndpoints(nil, nil, nil, nil) {
		operationID := endpoint.RouteContract().OperationID
		if _, ok := want[operationID]; !ok {
			t.Fatalf("unexpected public Recording operation %q", operationID)
		}
		delete(want, operationID)
	}
	for operationID := range want {
		t.Fatalf("missing public Recording operation %q", operationID)
	}
}

func TestPublicContractHasNoRecordingPipelineOperations(t *testing.T) {
	banned := map[string]struct{}{
		"createRecording":             {},
		"updateRecording":             {},
		"createRecordingReservation":  {},
		"getRecordingReservation":     {},
		"extendRecordingReservation":  {},
		"releaseRecordingReservation": {},
		"getRecordingPipeline":        {},
	}
	for _, contract := range PreviewRouteContracts() {
		if _, ok := banned[contract.OperationID]; ok {
			t.Fatalf("public contract still exposes %q", contract.OperationID)
		}
	}
}

type recordingExportHTTPRecordingStub struct {
	recording recordings.Recording
}

func (s recordingExportHTTPRecordingStub) Get(_ context.Context, _, _ utilities.ID) (recordings.Recording, error) {
	return s.recording, nil
}

func (s recordingExportHTTPRecordingStub) List(context.Context, utilities.ID, utilities.ID, utilities.ID, pagination.PageRequest) (recordings.RecordingList, error) {
	return recordings.RecordingList{}, nil
}

type recordingExportHTTPStub struct {
	jobID utilities.ID
	state recordingpipeline.ArtifactState
	calls int
}

func (s *recordingExportHTTPStub) RequestExport(_ context.Context, _ recordingpipeline.ExportInput) (recordingpipeline.Job, error) {
	s.calls++
	s.state.ExportJobID = &s.jobID
	s.state.ExportStatus = recordingpipeline.ExportStatusPending
	return recordingpipeline.Job{ID: s.jobID, Kind: recordingpipeline.JobKindRender}, nil
}

func (s *recordingExportHTTPStub) GetArtifactState(context.Context, utilities.ID, utilities.ID) (recordingpipeline.ArtifactState, error) {
	return s.state, nil
}

type recordingListHTTPStub struct {
	list      recordings.RecordingList
	tenantID  utilities.ID
	spaceID   utilities.ID
	episodeID utilities.ID
}

func (s *recordingListHTTPStub) Get(_ context.Context, _, _ utilities.ID) (recordings.Recording, error) {
	return recordings.Recording{}, recordings.ErrRecordingNotFound
}

func (s *recordingListHTTPStub) List(_ context.Context, tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID, _ pagination.PageRequest) (recordings.RecordingList, error) {
	s.tenantID = tenantID
	s.spaceID = spaceID
	s.episodeID = episodeID
	return s.list, nil
}

type recordingListExportHTTPStub struct {
	states      map[utilities.ID]recordingpipeline.ArtifactState
	batchCalls  int
	singleCalls int
}

func (s *recordingListExportHTTPStub) RequestExport(context.Context, recordingpipeline.ExportInput) (recordingpipeline.Job, error) {
	return recordingpipeline.Job{}, recordingpipeline.ErrPipelineNotFound
}

func (s *recordingListExportHTTPStub) GetArtifactState(_ context.Context, _ utilities.ID, recordingID utilities.ID) (recordingpipeline.ArtifactState, error) {
	s.singleCalls++
	return s.states[recordingID], nil
}

func (s *recordingListExportHTTPStub) GetArtifactStates(_ context.Context, _ utilities.ID, _ []utilities.ID) (map[utilities.ID]recordingpipeline.ArtifactState, error) {
	s.batchCalls++
	return s.states, nil
}

func TestListRecordingsFiltersBySpaceAndBatchesArtifactStates(t *testing.T) {
	tenantID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be020")
	spaceID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be021")
	episodeID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be022")
	firstRecordingID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be023")
	secondRecordingID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be024")
	now := time.Date(2031, 2, 3, 4, 5, 6, 0, time.UTC)
	service := &recordingListHTTPStub{list: recordings.RecordingList{Recordings: []recordings.Recording{
		{ID: firstRecordingID, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, Status: recordings.StatusCompleted, StorageProvider: recordings.StorageProviderR2, CreatedAt: now, UpdatedAt: now},
		{ID: secondRecordingID, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, Status: recordings.StatusCompleted, StorageProvider: recordings.StorageProviderR2, CreatedAt: now.Add(-time.Second), UpdatedAt: now},
	}}}
	exports := &recordingListExportHTTPStub{states: map[utilities.ID]recordingpipeline.ArtifactState{
		firstRecordingID: {
			SourceStatus: recordingpipeline.SourceStatusAvailable, ExportStatus: recordingpipeline.ExportStatusNone,
			TranscriptionPolicy:            artifactpolicy.TranscriptionOnDemand,
			TranscriptionPreparationStatus: recordingpipeline.TranscriptionPreparationReady,
		},
		secondRecordingID: {
			SourceStatus: recordingpipeline.SourceStatusAvailable, ExportStatus: recordingpipeline.ExportStatusReady,
			TranscriptionPolicy:            artifactpolicy.TranscriptionDisabled,
			TranscriptionPreparationStatus: recordingpipeline.TranscriptionPreparationNone,
		},
	}}
	authorizer := &preparationAuthorizer{}
	router := chi.NewRouter()
	listRecordingsEndpoint(service, exports, authorizer).Mount(router, RateLimitOptions{})

	request := httptest.NewRequest(http.MethodGet, "/tenants/"+tenantID.String()+"/recordings?space_id="+spaceID.String()+"&episode_id="+episodeID.String(), nil)
	request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalSystem}))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if service.tenantID != tenantID || service.spaceID != spaceID || service.episodeID != episodeID {
		t.Fatalf("list filter tenant=%s space=%s episode=%s", service.tenantID, service.spaceID, service.episodeID)
	}
	if exports.batchCalls != 1 || exports.singleCalls != 0 {
		t.Fatalf("artifact calls batch=%d single=%d", exports.batchCalls, exports.singleCalls)
	}
	if authorizer.permission != readRecordingsPermission {
		t.Fatalf("permission=%+v", authorizer.permission)
	}
	var body recordingListResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode recording list: %v", err)
	}
	if len(body.Recordings) != 2 || body.Recordings[0].TranscriptionPolicy != artifactpolicy.TranscriptionOnDemand || body.Recordings[1].TranscriptionPolicy != artifactpolicy.TranscriptionDisabled {
		t.Fatalf("frozen transcription policies=%+v", body.Recordings)
	}
	if body.Recordings[0].TranscriptionPreparation.Status != recordingpipeline.TranscriptionPreparationReady || body.Recordings[1].TranscriptionPreparation.Status != recordingpipeline.TranscriptionPreparationNone {
		t.Fatalf("transcription preparation statuses=%+v", body.Recordings)
	}
}

func TestRecordingExportRequestIsAuthorizedAndReusesPendingExport(t *testing.T) {
	tenantID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be001")
	recordingID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be002")
	exportJobID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be003")
	sourceExpiresAt := time.Date(2031, 2, 3, 4, 5, 6, 0, time.UTC)
	recordingsService := recordingExportHTTPRecordingStub{recording: recordings.Recording{
		ID: recordingID, TenantID: tenantID,
		SpaceID:   mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be004"),
		EpisodeID: mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be005"),
		Status:    "completed", StorageProvider: "r2", CreatedAt: sourceExpiresAt, UpdatedAt: sourceExpiresAt,
	}}
	exports := &recordingExportHTTPStub{jobID: exportJobID, state: recordingpipeline.ArtifactState{
		SourceStatus: recordingpipeline.SourceStatusAvailable, SourceExpiresAt: &sourceExpiresAt,
		ExportStatus: recordingpipeline.ExportStatusNone,
	}}
	authorizer := &preparationAuthorizer{}
	router := chi.NewRouter()
	requestRecordingExportEndpoint(recordingsService, exports, authorizer).Mount(router, RateLimitOptions{})

	for requestNumber := 0; requestNumber < 2; requestNumber++ {
		request := httptest.NewRequest(http.MethodPost, "/tenants/"+tenantID.String()+"/recordings/"+recordingID.String()+"/export", strings.NewReader(`{}`))
		request.Header.Set("Content-Type", "application/json")
		request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalSystem}))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusAccepted {
			t.Fatalf("request %d status=%d body=%s", requestNumber+1, response.Code, response.Body.String())
		}
		var body struct {
			Export recordingExportResponse `json:"export"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode request %d response: %v", requestNumber+1, err)
		}
		if body.Export.Status != string(recordingpipeline.ExportStatusPending) || body.Export.JobID != exportJobID.String() || body.Export.SourceExpiresAt == nil || *body.Export.SourceExpiresAt != utilities.FormatTimestamp(sourceExpiresAt) {
			t.Fatalf("request %d export=%+v", requestNumber+1, body.Export)
		}
	}
	if exports.calls != 2 {
		t.Fatalf("idempotent export request calls=%d, want 2 repository requests for one stable job", exports.calls)
	}
	if authorizer.permission != readRecordingsPermission {
		t.Fatalf("permission=%+v", authorizer.permission)
	}
}

func TestRecordingDownloadURLUsesBoundedLifetimeAndExplicitAttachment(t *testing.T) {
	tenantID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be030")
	recordingID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be031")
	storageKey := recordings.TenantStorageKeyPrefix(tenantID) + "exports/" + recordingID.String() + ".mp4"
	now := time.Date(2031, 2, 3, 4, 5, 6, 0, time.UTC)
	service := recordingExportHTTPRecordingStub{recording: recordings.Recording{
		ID: recordingID, TenantID: tenantID,
		SpaceID:   mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be032"),
		EpisodeID: mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be033"),
		Status:    recordings.StatusCompleted, StorageProvider: recordings.StorageProviderR2, StorageKey: &storageKey, CreatedAt: now, UpdatedAt: now,
	}}
	exports := &recordingExportHTTPStub{state: recordingpipeline.ArtifactState{ExportStatus: recordingpipeline.ExportStatusReady}}

	for _, test := range []struct {
		name               string
		body               string
		status             int
		contentDisposition string
	}{
		{name: "inline default", body: `{"expires_in_seconds":300}`, status: http.StatusOK},
		{name: "attachment", body: `{"expires_in_seconds":300,"download":true}`, status: http.StatusOK, contentDisposition: "attachment; filename=recording-" + recordingID.String() + ".mp4"},
		{name: "lifetime too long", body: `{"expires_in_seconds":900}`, status: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			downloads := &recordingDownloadHTTPStub{signedAt: now}
			authorizer := &preparationAuthorizer{}
			router := chi.NewRouter()
			createRecordingDownloadURLEndpoint(service, exports, downloads, authorizer).Mount(router, RateLimitOptions{})

			request := httptest.NewRequest(http.MethodPost, "/tenants/"+tenantID.String()+"/recordings/"+recordingID.String()+"/download-url", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalSystem}))
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if test.status != http.StatusOK {
				if downloads.calls != 0 {
					t.Fatalf("download signer calls=%d, want 0", downloads.calls)
				}
				return
			}
			if downloads.input.Key != storageKey || downloads.input.ExpiresIn != 5*time.Minute || downloads.input.ContentDisposition != test.contentDisposition {
				t.Fatalf("download signer input=%+v", downloads.input)
			}
		})
	}
}

func TestRecordingResponseKeepsAvailableSourceWhenExportFailed(t *testing.T) {
	recordingID := mustRecordingContractID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be010")
	sourceExpiresAt := time.Date(2031, 2, 3, 4, 5, 6, 0, time.UTC)
	response := newRecordingResponse(recordings.Recording{
		ID: recordingID, TenantID: recordingID, SpaceID: recordingID, EpisodeID: recordingID,
		Status: "completed", CreatedAt: sourceExpiresAt, UpdatedAt: sourceExpiresAt,
	}, recordingpipeline.ArtifactState{
		SourceStatus: recordingpipeline.SourceStatusAvailable, SourceExpiresAt: &sourceExpiresAt,
		TranscriptionPolicy: artifactpolicy.TranscriptionOnDemand,
		ExportStatus:        recordingpipeline.ExportStatusFailed, FailureCode: "render.failed", FailureMessage: "The MP4 export could not be completed.",
	})
	if response.Source.Status != string(recordingpipeline.SourceStatusAvailable) || response.Export.Status != string(recordingpipeline.ExportStatusFailed) || response.TranscriptionPolicy != artifactpolicy.TranscriptionOnDemand || response.Export.FailureCode == nil || response.Export.FailureMessage == nil {
		t.Fatalf("source/export state=%+v/%+v", response.Source, response.Export)
	}
}

type recordingDownloadHTTPStub struct {
	calls    int
	input    objectstorage.CreateDownloadURLInput
	signedAt time.Time
}

func (s *recordingDownloadHTTPStub) CreateDownloadURL(_ context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	s.calls++
	s.input = input
	return objectstorage.SignedURL{Method: http.MethodGet, URL: "https://storage.example.test/recording.mp4", SignedAt: s.signedAt, ExpiresAt: s.signedAt.Add(input.ExpiresIn)}, nil
}

func mustRecordingContractID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse ID: %v", err)
	}
	return id
}
