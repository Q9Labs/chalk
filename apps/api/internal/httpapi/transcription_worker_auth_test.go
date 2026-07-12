package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

type memoryNonceStore struct {
	mu   sync.Mutex
	seen map[string]bool
}

func (s *memoryNonceStore) Consume(_ context.Context, nonce string, _ time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen[nonce] {
		return false, nil
	}
	s.seen[nonce] = true
	return true, nil
}

func signedWorkloadRequest(t *testing.T, now time.Time, secret []byte, nonce, body string) *http.Request {
	t.Helper()
	path := "/internal/v1/transcription/jobs/heartbeat"
	timestamp := now.Unix()
	bodyHash := sha256.Sum256([]byte(body))
	canonical := "POST\n" + path + "\n" + hex.EncodeToString(bodyHash[:]) + "\n" +
		formatInt(timestamp) + "\n" + nonce + "\nlocal\nrelease\ntranscription-dispatcher\njourney\ntrace\n\naudience"
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(canonical))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	request := httptest.NewRequest("POST", "http://api"+path, bytes.NewBufferString(body))
	request.Header.Set("Authorization", "Chalk-Workload-HMAC "+signature)
	request.Header.Set(workloadTimestampHeader, formatInt(timestamp))
	request.Header.Set(workloadNonceHeader, nonce)
	request.Header.Set(workloadEnvironmentHeader, "local")
	request.Header.Set(workloadReleaseHeader, "release")
	request.Header.Set(workloadRoleHeader, transcriptionWorkloadRole)
	request.Header.Set(workloadAudienceHeader, "audience")
	request.Header.Set(workloadBodySHAHeader, hex.EncodeToString(bodyHash[:]))
	request.Header.Set(workloadJourneyHeader, "journey")
	request.Header.Set(workloadTraceparentHeader, "trace")
	return request
}

func formatInt(value int64) string {
	return strconv.FormatInt(value, 10)
}

func TestHMACWorkloadAuthorizerBindsRequestAndRejectsReplay(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	secret := []byte("test-secret")
	store := &memoryNonceStore{seen: map[string]bool{}}
	authorizer := NewHMACWorkloadAuthorizer(HMACWorkloadAuthorizerConfig{
		Secret: secret, Environment: "local", ReleaseID: "release", Audience: "audience",
		Clock: func() time.Time { return now }, Nonces: store, Window: time.Minute,
	})
	request := signedWorkloadRequest(t, now, secret, "nonce-1234567890", `{"job_id":"x"}`)
	if err := authorizer.AuthorizeWorkload(context.Background(), request, transcriptionWorkloadRole); err != nil {
		t.Fatalf("valid workload rejected: %v", err)
	}
	request = signedWorkloadRequest(t, now, secret, "nonce-1234567890", `{"job_id":"x"}`)
	if err := authorizer.AuthorizeWorkload(context.Background(), request, transcriptionWorkloadRole); err == nil {
		t.Fatal("replayed workload accepted")
	}
}

func TestHMACWorkloadAuthorizerRejectsBodyChecksumAndStaleTimestamp(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	secret := []byte("test-secret")
	store := &memoryNonceStore{seen: map[string]bool{}}
	authorizer := NewHMACWorkloadAuthorizer(HMACWorkloadAuthorizerConfig{
		Secret: secret, Environment: "local", ReleaseID: "release", Audience: "audience",
		Clock: func() time.Time { return now }, Nonces: store, Window: time.Minute,
	})
	request := signedWorkloadRequest(t, now, secret, "nonce-body-123456", `{"job_id":"x"}`)
	request.Header.Set(workloadBodySHAHeader, "00")
	if err := authorizer.AuthorizeWorkload(context.Background(), request, transcriptionWorkloadRole); err == nil {
		t.Fatal("body checksum mismatch accepted")
	}
	request = signedWorkloadRequest(t, now.Add(-2*time.Minute), secret, "nonce-stale-123456", `{"job_id":"x"}`)
	if err := authorizer.AuthorizeWorkload(context.Background(), request, transcriptionWorkloadRole); err == nil {
		t.Fatal("stale workload accepted")
	}
}

func TestHMACWorkloadAuthorizerAtomicNonceConsumption(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	secret := []byte("test-secret")
	store := &memoryNonceStore{seen: map[string]bool{}}
	authorizer := NewHMACWorkloadAuthorizer(HMACWorkloadAuthorizerConfig{Secret: secret, Environment: "local", ReleaseID: "release", Audience: "audience", Clock: func() time.Time { return now }, Nonces: store, Window: time.Minute})
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			results <- authorizer.AuthorizeWorkload(context.Background(), signedWorkloadRequest(t, now, secret, "nonce-concurrent-1234", `{"job_id":"x"}`), transcriptionWorkloadRole)
		}()
	}
	accepted := 0
	for i := 0; i < 2; i++ {
		if <-results == nil {
			accepted++
		}
	}
	if accepted != 1 {
		t.Fatalf("accepted %d concurrent uses of one nonce, want exactly one", accepted)
	}
}
