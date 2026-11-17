package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type claimRecordingService struct {
	RecorderWorkerService
	job recordingpipeline.Job
}

func (s claimRecordingService) Claim(context.Context, recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
	return s.job, nil
}

// previousClaimResponse is the claim response of the release before journey_id and trace_id. Its
// worker decodes with DisallowUnknownFields, so any field it does not list leaves a leased job
// that never starts.
type previousClaimResponse struct {
	ClaimRequestID string                                `json:"claim_request_id"`
	Envelope       recordingpipeline.RecorderJobEnvelope `json:"envelope"`
	EnvelopeDigest string                                `json:"envelope_digest"`
	LeaseToken     string                                `json:"lease_token"`
	LeaseOwner     string                                `json:"lease_owner"`
	LeaseExpiresAt string                                `json:"lease_expires_at"`
}

func claimResponseBody(t *testing.T, request recorderprotocol.ClaimRequest) []byte {
	t.Helper()
	journeyID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	claimID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	workerID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	request.ClaimRequestID, request.LeaseForSeconds = claimID.String(), 60
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	service := claimRecordingService{job: recordingpipeline.Job{Authority: &recordingpipeline.JobAuthority{
		LeaseToken: "token", LeaseOwner: "owner", LeaseExpiresAt: time.Unix(1_800_000_000, 0).UTC(),
		EnvelopeDigest: bytes.Repeat([]byte{3}, 32), JourneyID: journeyID, TraceID: strings.Repeat("a", 32),
	}}}
	httpRequest := httptest.NewRequest(http.MethodPost, "/recorder/jobs/claim", bytes.NewReader(payload))
	httpRequest = httpRequest.WithContext(context.WithValue(httpRequest.Context(), recorderWorkerIdentityContextKey{},
		workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleCapture}))
	response := httptest.NewRecorder()
	recorderWorkerClaimHandler(service)(response, httpRequest)
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	return response.Body.Bytes()
}

func TestClaimResponseStaysDecodableByThePreviousRelease(t *testing.T) {
	body := claimResponseBody(t, recorderprotocol.ClaimRequest{})
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var previous previousClaimResponse
	if err := decoder.Decode(&previous); err != nil {
		t.Fatalf("a worker that did not ask for correlation must get the old shape: %v\n%s", err, body)
	}
}

func TestClaimResponseCarriesCorrelationOnlyWhenTheWorkerAsks(t *testing.T) {
	body := claimResponseBody(t, recorderprotocol.ClaimRequest{SupportsClaimCorrelation: true})
	var response recorderprotocol.ClaimResponse
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	if response.JourneyID == "" || response.TraceID != strings.Repeat("a", 32) {
		t.Fatalf("worker asked for correlation and got journey %q trace %q", response.JourneyID, response.TraceID)
	}
}
