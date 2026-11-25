package control

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type SignedUpload struct {
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt string            `json:"expiresAt"`
}

type PageUploads struct {
	Page      int          `json:"page"`
	Image     SignedUpload `json:"image"`
	Thumbnail SignedUpload `json:"thumbnail"`
	Zoom      SignedUpload `json:"zoom"`
}

type Assignment struct {
	JobID           string        `json:"jobId"`
	TenantID        string        `json:"tenantId"`
	SpaceID         string        `json:"spaceId"`
	DocumentID      string        `json:"documentId"`
	Kind            string        `json:"kind"`
	PageStart       int           `json:"pageStart"`
	PageEnd         int           `json:"pageEnd"`
	Attempt         int           `json:"attempt"`
	LeaseToken      string        `json:"leaseToken"`
	LeaseExpiresAt  string        `json:"leaseExpiresAt"`
	FileName        string        `json:"fileName"`
	MIMEType        string        `json:"mimeType"`
	SourceURL       string        `json:"sourceUrl"`
	SourceSizeBytes int64         `json:"sourceSizeBytes"`
	SourceSHA256    string        `json:"sourceSha256"`
	Uploads         []PageUploads `json:"uploads"`
}

type ControlClient struct {
	baseURL     string
	secret      string
	environment string
	releaseID   string
	audience    string
	httpClient  *http.Client
	journeyID   string
	traceparent string
	tracestate  string
}

func NewControlClient(baseURL, secret, environment, releaseID, audience string) ControlClient {
	return ControlClient{baseURL: strings.TrimRight(baseURL, "/"), secret: secret, environment: environment, releaseID: releaseID, audience: audience, httpClient: &http.Client{Timeout: 20 * time.Second}}
}

func (c ControlClient) Claim(ctx context.Context, jobID string) (*Assignment, error) {
	body, _ := json.Marshal(map[string]string{"job_id": jobID})
	status, response, err := c.request(ctx, http.MethodPost, "/internal/v1/presenting/render/claim", body)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNoContent {
		return nil, nil
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("claim failed with status %d: %s", status, strings.TrimSpace(string(response)))
	}
	var assignment Assignment
	if err := json.Unmarshal(response, &assignment); err != nil {
		return nil, fmt.Errorf("decode assignment: %w", err)
	}
	return &assignment, nil
}

func (c ControlClient) Heartbeat(ctx context.Context, assignment Assignment) error {
	return c.postLease(ctx, "/internal/v1/presenting/render/heartbeat", leaseBody(assignment, 0))
}

func (c ControlClient) CompleteInventory(ctx context.Context, assignment Assignment, pages []map[string]int) error {
	body := leaseBody(assignment, 0)
	body["page_count"] = len(pages)
	body["pages"] = pages
	return c.postLease(ctx, "/internal/v1/presenting/render/inventory/complete", body)
}

func (c ControlClient) PageReady(ctx context.Context, assignment Assignment, page int) error {
	return c.postLease(ctx, "/internal/v1/presenting/render/page-ready", leaseBody(assignment, page))
}

func (c ControlClient) Complete(ctx context.Context, assignment Assignment) error {
	return c.postLease(ctx, "/internal/v1/presenting/render/complete", leaseBody(assignment, 0))
}

func (c ControlClient) CompleteZoom(ctx context.Context, assignment Assignment, page int) error {
	return c.postLease(ctx, "/internal/v1/presenting/render/zoom/complete", leaseBody(assignment, page))
}

func (c ControlClient) Fail(ctx context.Context, assignment Assignment, code, message string) error {
	body := leaseBody(assignment, 0)
	body["code"] = code
	if len(message) > 450 {
		message = message[:450]
	}
	body["message"] = message
	return c.postLease(ctx, "/internal/v1/presenting/render/fail", body)
}

func (c ControlClient) WithJourney(journeyID, traceparent, tracestate string) ControlClient {
	c.journeyID, c.traceparent, c.tracestate = journeyID, traceparent, tracestate
	return c
}

func leaseBody(assignment Assignment, page int) map[string]any {
	return map[string]any{
		"job_id": assignment.JobID, "tenant_id": assignment.TenantID, "space_id": assignment.SpaceID,
		"document_id": assignment.DocumentID, "attempt": assignment.Attempt, "lease_token": assignment.LeaseToken, "page": page,
	}
}

func (c ControlClient) postLease(ctx context.Context, path string, value map[string]any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	status, response, err := c.request(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	if status == http.StatusNoContent || status == http.StatusOK {
		return nil
	}
	return fmt.Errorf("%s failed with status %d: %s", path, status, strings.TrimSpace(string(response)))
}

func (c ControlClient) request(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	for name, value := range c.sign(method, path, body) {
		request.Header.Set(name, value)
	}
	request.Header.Set("content-type", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return response.StatusCode, responseBody, err
}

// SignedHeaders exposes the production signer for cross-module interoperability
// tests. Runtime requests continue to use the unexported sign path.
func (c ControlClient) SignedHeaders(method, path string, body []byte) map[string]string {
	return c.sign(method, path, body)
}

func (c ControlClient) sign(method, path string, body []byte) map[string]string {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonceBytes := make([]byte, 16)
	_, _ = rand.Read(nonceBytes)
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes)
	digest := sha256.Sum256(body)
	bodySHA := hex.EncodeToString(digest[:])
	canonical := strings.Join([]string{strings.ToUpper(method), path, bodySHA, timestamp, nonce, c.environment, c.releaseID, "document-renderer", c.journeyID, c.traceparent, c.tracestate, c.audience}, "\n")
	mac := hmac.New(sha256.New, []byte(c.secret))
	_, _ = mac.Write([]byte(canonical))
	return map[string]string{
		"authorization":                "Chalk-Workload-HMAC " + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)),
		"x-chalk-workload-timestamp":   timestamp,
		"x-chalk-workload-nonce":       nonce,
		"x-chalk-workload-environment": c.environment,
		"x-chalk-workload-release":     c.releaseID,
		"x-chalk-workload-role":        "document-renderer",
		"x-chalk-workload-audience":    c.audience,
		"x-chalk-workload-body-sha256": bodySHA,
		"x-chalk-journey-id":           c.journeyID,
		"traceparent":                  c.traceparent,
		"tracestate":                   c.tracestate,
	}
}
