// Package recorderworker holds the recorder worker job contract and the capture and render
// daemons. It has no database, object-storage or provider SDK dependency.
package recorderworker

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const ProtocolVersion = "recorder-worker.v1"

var (
	ErrInvalidJob = errors.New("invalid recorder worker job")
)

// Job is the complete immutable identity and bounded authority given to one
// worker attempt. Authorization contains scoped, expiring intents only; it is
// intentionally not a reusable credential or provider token.
type Job struct {
	ProtocolVersion   string           `json:"protocol_version"`
	JobID             string           `json:"job_id"`
	TenantID          string           `json:"tenant_id"`
	EpisodeID         string           `json:"episode_id"`
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
	EpisodeEpoch   string    `json:"episode_epoch"`
	KeyAuthorityID string    `json:"key_authority_id,omitempty"`
}

func (j Job) Validate(now time.Time) error {
	if j.ProtocolVersion != ProtocolVersion || j.JobID == "" || j.TenantID == "" || j.EpisodeID == "" || j.ArtifactClass == "" {
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
