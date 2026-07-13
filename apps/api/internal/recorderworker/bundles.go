package recorderworker

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

const (
	MinBundleDurationMs = int64(10_000)
	MaxBundleDurationMs = int64(15_000)
)

func NewTemporaryObjectKey(tenantID, recordingID string, sequence int64) (string, error) {
	if tenantID == "" || recordingID == "" || sequence < 0 || strings.ContainsAny(tenantID+recordingID, "/\\") || strings.Contains(tenantID+recordingID, "..") {
		return "", errors.New("tenant and recording IDs must be safe temporary-key segments")
	}
	randomPart := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, randomPart); err != nil {
		return "", err
	}
	return fmt.Sprintf("tmp/%s/%s/%06d-%x", tenantID, recordingID, sequence, randomPart), nil
}

type BundleManifest struct {
	Version           string `json:"version"`
	RecordingID       string `json:"recording_id"`
	TenantID          string `json:"tenant_id"`
	Sequence          int64  `json:"sequence"`
	Attempt           int    `json:"attempt"`
	FencingGeneration int64  `json:"fencing_generation"`
	StartMs           int64  `json:"start_ms"`
	EndMs             int64  `json:"end_ms"`
	MonotonicStartMs  int64  `json:"monotonic_start_ms"`
	MonotonicEndMs    int64  `json:"monotonic_end_ms"`
	Codec             string `json:"codec"`
	Layer             string `json:"layer"`
	Bytes             int64  `json:"bytes"`
	Checksum          string `json:"checksum"`
	ObjectKey         string `json:"object_key"`
	Encryption        string `json:"encryption"`
	CloseReason       string `json:"close_reason,omitempty"`
}

func NewBundleManifest(recordingID, tenantID string, sequence int64, attempt int, generation, startMs, endMs int64, codec, layer, objectKey string, bytes int64, checksum string) (BundleManifest, error) {
	return NewBundleManifestWithCloseReason(recordingID, tenantID, sequence, attempt, generation, startMs, endMs, codec, layer, objectKey, bytes, checksum, "")
}

func NewBundleManifestWithCloseReason(recordingID, tenantID string, sequence int64, attempt int, generation, startMs, endMs int64, codec, layer, objectKey string, bytes int64, checksum, closeReason string) (BundleManifest, error) {
	duration := endMs - startMs
	if recordingID == "" || tenantID == "" || sequence < 0 || attempt < 1 || generation < 1 || duration <= 0 || duration > MaxBundleDurationMs || (duration < MinBundleDurationMs && closeReason == "") || codec == "" || layer == "" || objectKey == "" || bytes < 0 || checksum == "" {
		return BundleManifest{}, errors.New("invalid capture bundle manifest")
	}
	return BundleManifest{Version: "capture-bundle.v1", RecordingID: recordingID, TenantID: tenantID, Sequence: sequence, Attempt: attempt, FencingGeneration: generation, StartMs: startMs, EndMs: endMs, MonotonicStartMs: startMs, MonotonicEndMs: endMs, Codec: codec, Layer: layer, Bytes: bytes, Checksum: checksum, ObjectKey: objectKey, Encryption: "AES-256-GCM", CloseReason: closeReason}, nil
}

func ValidateBundleFencing(manifest BundleManifest, attempt int, generation int64) error {
	if manifest.Attempt != attempt || manifest.FencingGeneration != generation {
		return fmt.Errorf("%w: bundle attempt=%d generation=%d expected attempt=%d generation=%d", ErrFencedAttempt, manifest.Attempt, manifest.FencingGeneration, attempt, generation)
	}
	return nil
}

func ValidateBundleContinuity(previous, next BundleManifest) (CaptureGap, error) {
	if previous.RecordingID != next.RecordingID || previous.TenantID != next.TenantID {
		return CaptureGap{}, errors.New("bundle identity changed")
	}
	if next.Sequence != previous.Sequence+1 {
		return CaptureGap{}, fmt.Errorf("bundle sequence is not contiguous: previous=%d next=%d", previous.Sequence, next.Sequence)
	}
	if next.StartMs < previous.EndMs {
		return CaptureGap{}, errors.New("capture bundles overlap")
	}
	gap, hasGap := AttributeCaptureGap(previous.EndMs, next.StartMs, "capture_worker_gap")
	if hasGap {
		return gap, nil
	}
	return CaptureGap{}, nil
}

type CaptureGap struct {
	StartMs int64  `json:"start_ms"`
	EndMs   int64  `json:"end_ms"`
	Reason  string `json:"reason"`
}

func AttributeCaptureGap(previousEndMs, nextStartMs int64, reason string) (CaptureGap, bool) {
	if nextStartMs <= previousEndMs {
		return CaptureGap{}, false
	}
	if reason == "" {
		reason = "worker_replacement"
	}
	return CaptureGap{StartMs: previousEndMs, EndMs: nextStartMs, Reason: reason}, true
}

type KeyProvider interface {
	RecordingKey(context.Context, string) ([]byte, error)
}

// MemoryKeyProvider is the local proof implementation. It has no persistence
// or provider credentials and returns a freshly generated key per recording.
type MemoryKeyProvider struct {
	mu   sync.Mutex
	keys map[string][]byte
}

func (p *MemoryKeyProvider) RecordingKey(_ context.Context, recordingID string) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.keys == nil {
		p.keys = make(map[string][]byte)
	}
	if key, ok := p.keys[recordingID]; ok {
		return append([]byte(nil), key...), nil
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	p.keys[recordingID] = append([]byte(nil), key...)
	return append([]byte(nil), key...), nil
}

func (p *MemoryKeyProvider) Clear(recordingID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.keys, recordingID)
}

type EncryptedBundle struct {
	Version    string `json:"version"`
	Algorithm  string `json:"algorithm"`
	Nonce      string `json:"nonce"`
	Metadata   string `json:"metadata"`
	Ciphertext string `json:"ciphertext"`
}

func EncryptBundle(ctx context.Context, provider KeyProvider, recordingID string, metadata BundleManifest, plaintext []byte) (EncryptedBundle, error) {
	if provider == nil || recordingID == "" {
		return EncryptedBundle{}, errors.New("key provider and recording ID are required")
	}
	if metadata.Bytes != int64(len(plaintext)) || metadata.Checksum != Checksum(plaintext) {
		return EncryptedBundle{}, errors.New("bundle plaintext does not match manifest size and checksum")
	}
	key, err := provider.RecordingKey(ctx, recordingID)
	if err != nil {
		return EncryptedBundle{}, err
	}
	if len(key) != 32 {
		return EncryptedBundle{}, errors.New("recording key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return EncryptedBundle{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return EncryptedBundle{}, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return EncryptedBundle{}, err
	}
	metadataBytes, err := json.Marshal(metadata)
	if err != nil {
		return EncryptedBundle{}, err
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, metadataBytes)
	return EncryptedBundle{Version: "recording-envelope.v1", Algorithm: "AES-256-GCM", Nonce: base64.RawStdEncoding.EncodeToString(nonce), Metadata: base64.RawStdEncoding.EncodeToString(metadataBytes), Ciphertext: base64.RawStdEncoding.EncodeToString(ciphertext)}, nil
}

// WrapFixtureKey and UnwrapFixtureKey are only for the local CLI proof. The
// production worker receives a plaintext key over a job-scoped mTLS channel and
// never persists it. The fixture stores only this separately wrapped key.
func WrapFixtureKey(key []byte) (EncryptedBundle, error) {
	if len(key) != 32 {
		return EncryptedBundle{}, errors.New("fixture key must be 32 bytes")
	}
	return encryptWithKey(fixtureWrapKey(), key, []byte("chalk-recorder-fixture-key-v1"))
}

func UnwrapFixtureKey(envelope EncryptedBundle) ([]byte, error) {
	return decryptWithKey(fixtureWrapKey(), envelope, []byte("chalk-recorder-fixture-key-v1"))
}

func fixtureWrapKey() []byte {
	sum := sha256.Sum256([]byte("chalk-recorder-fixture-wrap-v1"))
	return sum[:]
}

func encryptWithKey(key, plaintext, aad []byte) (EncryptedBundle, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return EncryptedBundle{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return EncryptedBundle{}, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return EncryptedBundle{}, err
	}
	return EncryptedBundle{Version: "fixture-key-wrap.v1", Algorithm: "AES-256-GCM", Nonce: base64.RawStdEncoding.EncodeToString(nonce), Metadata: base64.RawStdEncoding.EncodeToString(aad), Ciphertext: base64.RawStdEncoding.EncodeToString(gcm.Seal(nil, nonce, plaintext, aad))}, nil
}

func decryptWithKey(key []byte, envelope EncryptedBundle, aad []byte) ([]byte, error) {
	if envelope.Version != "fixture-key-wrap.v1" || envelope.Algorithm != "AES-256-GCM" {
		return nil, errors.New("fixture key envelope algorithm is invalid")
	}
	metadata, err := base64.RawStdEncoding.DecodeString(envelope.Metadata)
	if err != nil || string(metadata) != string(aad) {
		return nil, errors.New("fixture key envelope metadata is invalid")
	}
	nonce, err := base64.RawStdEncoding.DecodeString(envelope.Nonce)
	if err != nil {
		return nil, err
	}
	ciphertext, err := base64.RawStdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, aad)
}

func DecryptBundle(key []byte, envelope EncryptedBundle) ([]byte, BundleManifest, error) {
	if len(key) != 32 || envelope.Version != "recording-envelope.v1" || envelope.Algorithm != "AES-256-GCM" {
		return nil, BundleManifest{}, errors.New("invalid envelope key or algorithm")
	}
	nonce, err := base64.RawStdEncoding.DecodeString(envelope.Nonce)
	if err != nil {
		return nil, BundleManifest{}, err
	}
	metadataBytes, err := base64.RawStdEncoding.DecodeString(envelope.Metadata)
	if err != nil {
		return nil, BundleManifest{}, err
	}
	ciphertext, err := base64.RawStdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return nil, BundleManifest{}, err
	}
	var metadata BundleManifest
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
		return nil, BundleManifest{}, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, BundleManifest{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, BundleManifest{}, err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, metadataBytes)
	if err != nil {
		return nil, BundleManifest{}, err
	}
	if metadata.Bytes != int64(len(plaintext)) || metadata.Checksum != Checksum(plaintext) {
		clear(plaintext)
		return nil, BundleManifest{}, errors.New("decrypted bundle does not match authenticated manifest")
	}
	return plaintext, metadata, nil
}

func BundleTime(now time.Time) int64 { return now.UnixMilli() }
