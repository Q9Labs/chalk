package recordingkeys

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

const BundleSchemaVersion = "recording_bundle.v1"

var (
	ErrInvalidRequest        = errors.New("invalid recording key request")
	ErrAuthorityMismatch     = errors.New("recording key authority mismatch")
	ErrKeyNotFound           = errors.New("recording key not found")
	ErrKeyConflict           = errors.New("recording key conflict")
	ErrKMSUnavailable        = errors.New("recording key kms unavailable")
	ErrRepositoryUnavailable = errors.New("recording key repository unavailable")
	ErrKMSFailed             = errors.New("recording key kms failed")
	ErrCiphertextInvalid     = errors.New("recording key ciphertext invalid")
	ErrPlaintextInvalid      = errors.New("recording key plaintext invalid")
)

// Authority is the complete authority tuple accepted by the private key
// broker. String IDs remain canonical UUIDs at this boundary so the HTTP
// adapter can validate without leaking database types into the domain.
type Authority struct {
	TenantID          string
	EpisodeID         string
	RecordingID       string
	JobID             string
	KeyHandle         string
	AttemptCount      int
	FencingGeneration int64
	CaptureEpoch      int64
	EnvelopeDigest    []byte
	LeaseToken        string
	LeaseOwner        string
	LeaseExpiresAt    time.Time
}

// EncryptionContext is frozen for one recording capture epoch. Attempt and
// fencing fields are checked as authority, but are intentionally not KMS
// context fields so retries in the same epoch can replay the one data key.
type EncryptionContext struct {
	Environment    string
	TenantID       string
	EpisodeID      string
	RecordingID    string
	JobID          string
	CaptureEpoch   int64
	BundleSchema   string
	EnvelopeDigest []byte
}

func (c EncryptionContext) Map() map[string]string {
	return map[string]string{
		"chalk.environment":     c.Environment,
		"chalk.tenant":          c.TenantID,
		"chalk.episode":         c.EpisodeID,
		"chalk.recording":       c.RecordingID,
		"chalk.recording_job":   c.JobID,
		"chalk.bundle_schema":   c.BundleSchema,
		"chalk.capture_epoch":   strconv.FormatInt(c.CaptureEpoch, 10),
		"chalk.envelope_digest": hex.EncodeToString(c.EnvelopeDigest),
	}
}

// Digest returns a stable digest for persistence and object-allocation
// binding. KMS receives the map returned by Map; this method avoids map-order
// dependent serialization when the context is stored in Postgres.
func (c EncryptionContext) Digest() []byte {
	values := c.Map()
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var builder strings.Builder
	for _, key := range keys {
		builder.WriteString(key)
		builder.WriteByte('=')
		builder.WriteString(values[key])
		builder.WriteByte('\n')
	}
	digest := sha256.Sum256([]byte(builder.String()))
	return append([]byte(nil), digest[:]...)
}

type Record struct {
	Authority         Authority
	CiphertextBlob    []byte
	EncryptionContext EncryptionContext
	ContextDigest     []byte
	CreatedAt         time.Time
}

type DataKey struct {
	KeyHandle        string
	Plaintext        []byte
	CiphertextDigest []byte
	ContextDigest    []byte
	CaptureEpoch     int64
}

type KMS interface {
	GenerateDataKey(ctx context.Context, keyID string, encryptionContext map[string]string) (GenerateDataKeyResult, error)
	Decrypt(ctx context.Context, keyID string, ciphertextBlob []byte, encryptionContext map[string]string) ([]byte, error)
}

type GenerateDataKeyResult struct {
	Plaintext      []byte
	CiphertextBlob []byte
}

type Repository interface {
	Authorize(ctx context.Context, authority Authority) error
	Get(ctx context.Context, authority Authority) (Record, error)
	Save(ctx context.Context, record Record) error
}

func (a Authority) Context(environment string) EncryptionContext {
	return EncryptionContext{
		Environment:    environment,
		TenantID:       a.TenantID,
		EpisodeID:      a.EpisodeID,
		RecordingID:    a.RecordingID,
		JobID:          a.JobID,
		CaptureEpoch:   a.CaptureEpoch,
		BundleSchema:   BundleSchemaVersion,
		EnvelopeDigest: append([]byte(nil), a.EnvelopeDigest...),
	}
}

func (a Authority) Validate() error {
	for name, value := range map[string]string{
		"tenant_id": a.TenantID, "episode_id": a.EpisodeID, "recording_id": a.RecordingID,
		"job_id": a.JobID, "key_handle": a.KeyHandle,
	} {
		if !canonicalUUID(value) && name != "key_handle" {
			return fmt.Errorf("%w: %s", ErrInvalidRequest, name)
		}
		if name == "key_handle" && strings.TrimSpace(value) == "" {
			return fmt.Errorf("%w: %s", ErrInvalidRequest, name)
		}
	}
	if a.AttemptCount <= 0 || a.FencingGeneration <= 0 || a.CaptureEpoch <= 0 || len(a.EnvelopeDigest) != sha256.Size {
		return ErrInvalidRequest
	}
	if strings.TrimSpace(a.LeaseToken) == "" || strings.TrimSpace(a.LeaseOwner) == "" || a.LeaseExpiresAt.IsZero() {
		return ErrInvalidRequest
	}
	return nil
}

func (c EncryptionContext) Validate() error {
	if strings.TrimSpace(c.Environment) == "" || c.BundleSchema != BundleSchemaVersion || c.CaptureEpoch <= 0 || len(c.EnvelopeDigest) != sha256.Size {
		return ErrInvalidRequest
	}
	for _, value := range []string{c.TenantID, c.EpisodeID, c.RecordingID, c.JobID} {
		if !canonicalUUID(value) {
			return ErrInvalidRequest
		}
	}
	return nil
}

func SameAuthority(left, right Authority) bool {
	return left.TenantID == right.TenantID && left.EpisodeID == right.EpisodeID &&
		left.RecordingID == right.RecordingID && left.JobID == right.JobID &&
		left.KeyHandle == right.KeyHandle && left.AttemptCount == right.AttemptCount &&
		left.FencingGeneration == right.FencingGeneration && left.CaptureEpoch == right.CaptureEpoch &&
		bytes.Equal(left.EnvelopeDigest, right.EnvelopeDigest)
}

func SameContext(left, right EncryptionContext) bool {
	return left.Environment == right.Environment && left.TenantID == right.TenantID &&
		left.EpisodeID == right.EpisodeID && left.RecordingID == right.RecordingID &&
		left.JobID == right.JobID && left.CaptureEpoch == right.CaptureEpoch &&
		left.BundleSchema == right.BundleSchema && bytes.Equal(left.EnvelopeDigest, right.EnvelopeDigest)
}

func Digest(value []byte) []byte {
	digest := sha256.Sum256(value)
	return append([]byte(nil), digest[:]...)
}

func ClearPlaintext(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func canonicalUUID(value string) bool {
	if len(value) != 36 || strings.ToLower(value) != value {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if char != '-' {
				return false
			}
			continue
		}
		if !(char >= '0' && char <= '9') && !(char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}
