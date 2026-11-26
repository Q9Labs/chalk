package presenting

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	RenderCapabilityLifetime = 5 * time.Minute
	renderCapabilityVersion  = 1
)

var (
	ErrRenderCapabilityInvalid = errors.New("invalid presenting render capability")
	ErrRenderCapabilityExpired = errors.New("expired presenting render capability")
)

// RenderCapability is the bearer authority a renderer receives for exactly one
// job attempt. It is signed only inside the API; the renderer treats it as an
// opaque value and cannot mint authority for any other job.
type RenderCapability struct {
	TenantID   utilities.ID
	SpaceID    utilities.ID
	DocumentID utilities.ID
	JobID      utilities.ID
	Kind       string
	PageStart  int
	PageEnd    int
	Attempt    int
	ExpiresAt  time.Time
}

type renderCapabilityPayload struct {
	Version    int    `json:"v"`
	TenantID   string `json:"tenantId"`
	SpaceID    string `json:"spaceId"`
	DocumentID string `json:"documentId"`
	JobID      string `json:"jobId"`
	Kind       string `json:"kind"`
	PageStart  int    `json:"pageStart"`
	PageEnd    int    `json:"pageEnd"`
	Attempt    int    `json:"attempt"`
	ExpiresAt  int64  `json:"expiresAt"`
	Capability string `json:"capabilityId"`
}

type CapabilitySigner struct {
	secret []byte
	now    func() time.Time
}

func NewCapabilitySigner(secret string) (CapabilitySigner, error) {
	if len(secret) < 32 {
		return CapabilitySigner{}, fmt.Errorf("presenting render capability secret must contain at least 32 bytes")
	}
	return CapabilitySigner{secret: []byte(secret), now: time.Now}, nil
}

func (s CapabilitySigner) Issue(job RenderJob) (string, error) {
	if len(s.secret) < 32 || s.now == nil {
		return "", ErrRenderCapabilityInvalid
	}
	if job.JobID.IsZero() || job.TenantID.IsZero() || job.SpaceID.IsZero() || job.DocumentID.IsZero() || !validRenderJobShape(job.Kind, job.PageStart, job.PageEnd) {
		return "", ErrRenderCapabilityInvalid
	}
	capabilityID := make([]byte, 16)
	if _, err := rand.Read(capabilityID); err != nil {
		return "", fmt.Errorf("generate presenting render capability id: %w", err)
	}
	payload := renderCapabilityPayload{
		Version: renderCapabilityVersion, TenantID: job.TenantID.String(), SpaceID: job.SpaceID.String(), DocumentID: job.DocumentID.String(), JobID: job.JobID.String(),
		Kind: job.Kind, PageStart: job.PageStart, PageEnd: job.PageEnd, Attempt: job.Attempt + 1,
		ExpiresAt: s.now().UTC().Add(RenderCapabilityLifetime).Unix(), Capability: base64.RawURLEncoding.EncodeToString(capabilityID),
	}
	encodedPayload, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	message := "v1." + base64.RawURLEncoding.EncodeToString(encodedPayload)
	return message + "." + s.signature(message), nil
}

func (s CapabilitySigner) Verify(token string) (RenderCapability, error) {
	return s.verifyAt(token, s.now())
}

func (s CapabilitySigner) verifyAt(token string, now time.Time) (RenderCapability, error) {
	if len(s.secret) < 32 || len(token) > 4096 {
		return RenderCapability{}, ErrRenderCapabilityInvalid
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "v1" || parts[2] == "" {
		return RenderCapability{}, ErrRenderCapabilityInvalid
	}
	message := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(parts[2]), []byte(s.signature(message))) {
		return RenderCapability{}, ErrRenderCapabilityInvalid
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(payloadBytes) > 2048 {
		return RenderCapability{}, ErrRenderCapabilityInvalid
	}
	var payload renderCapabilityPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return RenderCapability{}, ErrRenderCapabilityInvalid
	}
	capability, err := payload.capability()
	if err != nil {
		return RenderCapability{}, err
	}
	if !now.UTC().Before(capability.ExpiresAt) {
		return RenderCapability{}, ErrRenderCapabilityExpired
	}
	return capability, nil
}

func (s CapabilitySigner) signature(message string) string {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(message))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (p renderCapabilityPayload) capability() (RenderCapability, error) {
	if p.Version != renderCapabilityVersion || p.Attempt < 1 || p.Attempt > RenderAttemptLimit || !validRenderJobShape(p.Kind, p.PageStart, p.PageEnd) || p.ExpiresAt <= 0 || len(p.Capability) < 16 {
		return RenderCapability{}, ErrRenderCapabilityInvalid
	}
	tenantID, err := utilities.ParseID(p.TenantID)
	if err != nil {
		return RenderCapability{}, ErrRenderCapabilityInvalid
	}
	spaceID, err := utilities.ParseID(p.SpaceID)
	if err != nil {
		return RenderCapability{}, ErrRenderCapabilityInvalid
	}
	documentID, err := utilities.ParseID(p.DocumentID)
	if err != nil {
		return RenderCapability{}, ErrRenderCapabilityInvalid
	}
	jobID, err := utilities.ParseID(p.JobID)
	if err != nil {
		return RenderCapability{}, ErrRenderCapabilityInvalid
	}
	return RenderCapability{TenantID: tenantID, SpaceID: spaceID, DocumentID: documentID, JobID: jobID, Kind: p.Kind, PageStart: p.PageStart, PageEnd: p.PageEnd, Attempt: p.Attempt, ExpiresAt: time.Unix(p.ExpiresAt, 0).UTC()}, nil
}

func (c RenderCapability) MatchesLease(lease RenderLease) bool {
	return c.TenantID == lease.TenantID && c.SpaceID == lease.SpaceID && c.DocumentID == lease.DocumentID && c.JobID == lease.JobID && c.Attempt == lease.Attempt
}

func validRenderJobShape(kind string, pageStart, pageEnd int) bool {
	if pageStart < 1 || pageEnd < pageStart || pageEnd > MaxPages {
		return false
	}
	switch kind {
	case "inventory":
		return pageStart == 1 && pageEnd == 1
	case "pages":
		return true
	case "zoom":
		return pageStart == pageEnd
	default:
		return false
	}
}
