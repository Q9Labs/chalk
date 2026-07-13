// Package recorderworker contains provider-neutral recorder worker contracts and
// deterministic media planning primitives. It deliberately has no database,
// object-storage, or provider SDK dependency.
package recorderworker

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const ProtocolVersion = "recorder-worker.v1"

var (
	ErrInvalidJob            = errors.New("invalid recorder worker job")
	ErrFencedAttempt         = errors.New("recorder worker attempt is fenced")
	ErrProviderUnimplemented = errors.New("recorder provider is not implemented")
)

// Job is the complete immutable identity and bounded authority given to one
// worker attempt. Authorization contains scoped, expiring intents only; it is
// intentionally not a reusable credential or provider token.
type Job struct {
	ProtocolVersion   string           `json:"protocol_version"`
	JobID             string           `json:"job_id"`
	TenantID          string           `json:"tenant_id"`
	SessionID         string           `json:"session_id"`
	Attempt           int              `json:"attempt"`
	FencingGeneration int64            `json:"fencing_generation"`
	Role              WorkerRole       `json:"role"`
	ArtifactClass     string           `json:"artifact_class"`
	JourneyID         string           `json:"journey_id,omitempty"`
	TraceParent       string           `json:"traceparent,omitempty"`
	TraceState        string           `json:"tracestate,omitempty"`
	ObjectIntents     []ObjectIntent   `json:"object_intents"`
	Authorization     JobAuthorization `json:"authorization"`
}

type WorkerRole string

const (
	RoleCapture WorkerRole = "capture"
	RoleRender  WorkerRole = "render"
)

// ObjectIntent is a single operation-scoped URL grant. A worker cannot use it
// to list, overwrite, or select an owner outside the declared key and bounds.
type ObjectIntent struct {
	Key            string    `json:"key"`
	URL            string    `json:"url"`
	Method         string    `json:"method"`
	ContentType    string    `json:"content_type,omitempty"`
	MaxBytes       int64     `json:"max_bytes"`
	ExpiresAt      time.Time `json:"expires_at"`
	Conditional    string    `json:"conditional,omitempty"`
	OwnerReference string    `json:"owner_reference"`
}

type JobAuthorization struct {
	IssuedAt       time.Time `json:"issued_at"`
	ExpiresAt      time.Time `json:"expires_at"`
	Scope          string    `json:"scope"`
	SessionEpoch   string    `json:"session_epoch"`
	KeyAuthorityID string    `json:"key_authority_id,omitempty"`
}

func (j Job) Validate(now time.Time) error {
	if j.ProtocolVersion != ProtocolVersion || j.JobID == "" || j.TenantID == "" || j.SessionID == "" || j.ArtifactClass == "" {
		return fmt.Errorf("%w: protocol and immutable IDs are required", ErrInvalidJob)
	}
	if j.Attempt < 1 || j.FencingGeneration < 1 || (j.Role != RoleCapture && j.Role != RoleRender) {
		return fmt.Errorf("%w: attempt, fencing generation, and role are invalid", ErrInvalidJob)
	}
	if j.Authorization.Scope == "" || j.Authorization.ExpiresAt.IsZero() || !j.Authorization.ExpiresAt.After(now) {
		return fmt.Errorf("%w: authorization is absent or expired", ErrInvalidJob)
	}
	if !j.Authorization.IssuedAt.IsZero() && j.Authorization.IssuedAt.After(now) {
		return fmt.Errorf("%w: authorization is not yet issued", ErrInvalidJob)
	}
	if !j.Authorization.IssuedAt.IsZero() && j.Authorization.ExpiresAt.Before(j.Authorization.IssuedAt) {
		return fmt.Errorf("%w: authorization expiry precedes issue time", ErrInvalidJob)
	}
	if len(j.ObjectIntents) == 0 {
		return fmt.Errorf("%w: at least one scoped object intent is required", ErrInvalidJob)
	}
	for i, intent := range j.ObjectIntents {
		if err := intent.validate(now); err != nil {
			return fmt.Errorf("%w: object intent %d: %v", ErrInvalidJob, i, err)
		}
		if intent.ExpiresAt.After(j.Authorization.ExpiresAt) {
			return fmt.Errorf("%w: object intent %d outlives job authority", ErrInvalidJob, i)
		}
	}
	return nil
}

func (i ObjectIntent) validate(now time.Time) error {
	if i.Key == "" || i.URL == "" || i.OwnerReference == "" || i.MaxBytes <= 0 || i.ExpiresAt.IsZero() || !i.ExpiresAt.After(now) {
		return errors.New("key, scoped URL, owner, positive size, and future expiry are required")
	}
	scopedURL, err := url.Parse(i.URL)
	if err != nil || scopedURL.Scheme != "https" || scopedURL.Host == "" || !strings.Contains(scopedURL.Path, i.Key) {
		return errors.New("object URL must be an HTTPS URL scoped to the object key")
	}
	method := strings.ToUpper(i.Method)
	if method != "PUT" && method != "POST" && method != "GET" {
		return errors.New("method must be PUT, POST, or GET")
	}
	if method == "GET" && i.Conditional != "" {
		return errors.New("GET object intents cannot carry write conditions")
	}
	if (method == "PUT" || method == "POST") && i.Conditional == "" {
		return errors.New("write object intents require a conditional create")
	}
	return nil
}

type EventType string

const (
	EventHeartbeat EventType = "heartbeat"
	EventProgress  EventType = "progress"
	EventTerminal  EventType = "terminal"
)

type WorkerEvent struct {
	ProtocolVersion   string          `json:"protocol_version"`
	Type              EventType       `json:"type"`
	JobID             string          `json:"job_id"`
	TenantID          string          `json:"tenant_id"`
	SessionID         string          `json:"session_id"`
	Attempt           int             `json:"attempt"`
	FencingGeneration int64           `json:"fencing_generation"`
	JourneyID         string          `json:"journey_id,omitempty"`
	TraceParent       string          `json:"traceparent,omitempty"`
	At                time.Time       `json:"at"`
	Heartbeat         *Heartbeat      `json:"heartbeat,omitempty"`
	Progress          *Progress       `json:"progress,omitempty"`
	Terminal          *TerminalResult `json:"terminal,omitempty"`
}

type Heartbeat struct {
	LeaseExpiresAt time.Time   `json:"lease_expires_at"`
	ResourceUse    ResourceUse `json:"resource_use"`
}

type Progress struct {
	Stage     string `json:"stage"`
	Completed int64  `json:"completed"`
	Total     int64  `json:"total"`
	Bytes     int64  `json:"bytes"`
	ObjectKey string `json:"object_key,omitempty"`
}

type ResourceUse struct {
	CPUSeconds  float64 `json:"cpu_seconds"`
	MemoryBytes int64   `json:"memory_bytes"`
	InputBytes  int64   `json:"input_bytes"`
	OutputBytes int64   `json:"output_bytes"`
}

type TerminalResult struct {
	Outcome      string      `json:"outcome"`
	ErrorCode    string      `json:"error_code,omitempty"`
	ErrorDetail  string      `json:"error_detail,omitempty"`
	ResourceUse  ResourceUse `json:"resource_use"`
	ArtifactKey  string      `json:"artifact_key,omitempty"`
	ArtifactHash string      `json:"artifact_hash,omitempty"`
}

func (e WorkerEvent) MarshalJSON() ([]byte, error) {
	type alias WorkerEvent
	if e.ProtocolVersion == "" {
		e.ProtocolVersion = ProtocolVersion
	}
	return json.Marshal(alias(e))
}

func (e WorkerEvent) Validate(now time.Time) error {
	if e.ProtocolVersion != ProtocolVersion {
		return errors.New("unsupported worker event protocol")
	}
	if e.JobID == "" || e.TenantID == "" || e.SessionID == "" || e.Attempt < 1 || e.FencingGeneration < 1 {
		return errors.New("worker event identity is incomplete")
	}
	if e.At.IsZero() || e.At.After(now.Add(5*time.Minute)) {
		return errors.New("worker event timestamp is invalid")
	}
	switch e.Type {
	case EventHeartbeat:
		if e.Heartbeat == nil || e.Heartbeat.LeaseExpiresAt.Before(e.At) {
			return errors.New("heartbeat lease is missing or expired")
		}
	case EventProgress:
		if e.Progress == nil || e.Progress.Stage == "" || e.Progress.Completed < 0 || e.Progress.Total < e.Progress.Completed {
			return errors.New("progress payload is invalid")
		}
	case EventTerminal:
		if e.Terminal == nil || e.Terminal.Outcome == "" {
			return errors.New("terminal outcome is missing")
		}
	default:
		return errors.New("unknown worker event type")
	}
	return nil
}

// CaptureProvider is the narrow provider boundary. Real Cloudflare/Pion
// integration is intentionally absent until its authentication contract lands.
type CaptureProvider interface {
	Capture(Job) (CaptureSession, error)
}

type RenderProvider interface {
	Render(Job) (RenderSession, error)
}

type CaptureSession interface{ Close() error }
type RenderSession interface{ Close() error }

type CloudflareCaptureProvider struct{}

func (CloudflareCaptureProvider) Capture(Job) (CaptureSession, error) {
	return nil, ErrProviderUnimplemented
}

type PionCaptureProvider struct{}

func (PionCaptureProvider) Capture(Job) (CaptureSession, error) { return nil, ErrProviderUnimplemented }

type GPURenderProvider struct{}

func (GPURenderProvider) Render(Job) (RenderSession, error) { return nil, ErrProviderUnimplemented }
