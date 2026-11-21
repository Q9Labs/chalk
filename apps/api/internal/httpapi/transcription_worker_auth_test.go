package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

type acceptingNonces struct{}

func (acceptingNonces) Consume(context.Context, string, time.Duration) (bool, error) {
	return true, nil
}

const (
	releaseTestSecret   = "release-test-secret"
	releaseTestEnv      = "test"
	releaseTestAudience = "chalk-control-api"
	releaseTestPath     = "/internal/v1/transcription/jobs/claim"
)

func signedClaimRequest(t *testing.T, release, secret string) *http.Request {
	t.Helper()
	body := `{"batch_size":1}`
	digest := sha256.Sum256([]byte(body))
	bodySHA := hex.EncodeToString(digest[:])
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonce := "0123456789abcdef0123"
	canonical := strings.Join([]string{"POST", releaseTestPath, bodySHA, timestamp, nonce, releaseTestEnv, release, transcriptionWorkloadRole, "journey", "", "", releaseTestAudience}, "\n")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	request := httptest.NewRequest(http.MethodPost, releaseTestPath, strings.NewReader(body))
	request.Header.Set("Authorization", "Chalk-Workload-HMAC "+base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	request.Header.Set(workloadTimestampHeader, timestamp)
	request.Header.Set(workloadNonceHeader, nonce)
	request.Header.Set(workloadEnvironmentHeader, releaseTestEnv)
	request.Header.Set(workloadReleaseHeader, release)
	request.Header.Set(workloadRoleHeader, transcriptionWorkloadRole)
	request.Header.Set(workloadAudienceHeader, releaseTestAudience)
	request.Header.Set(workloadBodySHAHeader, bodySHA)
	request.Header.Set(workloadJourneyHeader, "journey")
	return request
}

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &logs
}

func claimAs(t *testing.T, request *http.Request) (*httptest.ResponseRecorder, *claimFakeService) {
	t.Helper()
	authorizer := NewHMACWorkloadAuthorizer(HMACWorkloadAuthorizerConfig{Secret: []byte(releaseTestSecret), Environment: releaseTestEnv, ReleaseID: "release-new", Audience: releaseTestAudience, Nonces: acceptingNonces{}})
	service := &claimFakeService{}
	signer := claimFakeSigner{}
	recorder := httptest.NewRecorder()
	workerClaimHandler(service, authorizer, signer, signer, signer)(recorder, request)
	return recorder, service
}

func responseErrorCode(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not an error body: %v", err)
	}
	return body.Error.Code
}

func loggedEntry(t *testing.T, logs *bytes.Buffer) map[string]any {
	t.Helper()
	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &entry); err != nil {
		t.Fatalf("expected exactly one log line, got %q: %v", logs.String(), err)
	}
	return entry
}

func TestSupersededReleaseIsAnExpectedOutcome(t *testing.T) {
	logs := captureLogs(t)
	recorder, service := claimAs(t, signedClaimRequest(t, "release-old", releaseTestSecret))

	if recorder.Code != http.StatusConflict || responseErrorCode(t, recorder) != "workload.release_superseded" {
		t.Fatalf("response %d %s, want 409 workload.release_superseded", recorder.Code, recorder.Body.String())
	}
	if service.claims != 0 {
		t.Fatal("a superseded release must not reach the claim")
	}
	entry := loggedEntry(t, logs)
	if entry["level"] != "INFO" || entry["event"] != "workload.release_superseded" {
		t.Fatalf("log %v, want one INFO line named workload.release_superseded", entry)
	}
}

func TestReleaseMismatchWithoutAValidSignatureStaysUnauthorized(t *testing.T) {
	logs := captureLogs(t)
	recorder, _ := claimAs(t, signedClaimRequest(t, "release-old", "some-other-secret"))

	if recorder.Code != http.StatusUnauthorized || responseErrorCode(t, recorder) != "workload.unauthorized" {
		t.Fatalf("response %d %s, want 401 workload.unauthorized", recorder.Code, recorder.Body.String())
	}
	if entry := loggedEntry(t, logs); entry["level"] != "WARN" || entry["reason"] != "invalid workload signature" {
		t.Fatalf("log %v, want one WARN line with the signature reason", entry)
	}
}

func TestCurrentReleaseIsAccepted(t *testing.T) {
	recorder, _ := claimAs(t, signedClaimRequest(t, "release-new", releaseTestSecret))
	if recorder.Code != http.StatusOK {
		t.Fatalf("response %d %s, want 200", recorder.Code, recorder.Body.String())
	}
}
