package recordingkeys_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
)

func TestServiceGeneratesOnceAndReplaysWithDecrypt(t *testing.T) {
	authority := testAuthority()
	kms := &kmsStub{generated: recordingkeys.GenerateDataKeyResult{Plaintext: bytesOf(32, 7), CiphertextBlob: []byte("ciphertext")}}
	repository := &repositoryStub{}
	service, err := recordingkeys.NewService(kms, repository, recordingkeys.Config{Environment: "test", KeyID: "arn:test:kms", Now: func() time.Time { return time.Unix(10, 0) }})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	first, err := service.GetOrCreate(context.Background(), authority)
	if err != nil {
		t.Fatalf("first key: %v", err)
	}
	if kms.generateCalls != 1 || repository.saveCalls != 1 || string(first.Plaintext) != string(bytesOf(32, 7)) {
		t.Fatalf("first authority calls = generate %d save %d key %x", kms.generateCalls, repository.saveCalls, first.Plaintext)
	}
	expectedContext := map[string]string{
		"chalk.environment": "test", "chalk.tenant": authority.TenantID, "chalk.episode": authority.EpisodeID,
		"chalk.recording": authority.RecordingID, "chalk.recording_job": authority.JobID, "chalk.bundle_schema": recordingkeys.BundleSchemaVersion,
		"chalk.capture_epoch": "3", "chalk.envelope_digest": "0101010101010101010101010101010101010101010101010101010101010101",
	}
	if !reflect.DeepEqual(kms.generatedContext, expectedContext) {
		t.Fatalf("generate context = %#v, want %#v", kms.generatedContext, expectedContext)
	}
	recordingkeys.ClearPlaintext(first.Plaintext)

	kms.decrypted = bytesOf(32, 9)
	second, err := service.GetOrCreate(context.Background(), authority)
	if err != nil {
		t.Fatalf("replay key: %v", err)
	}
	if kms.generateCalls != 1 || kms.decryptCalls != 1 || repository.saveCalls != 1 || string(second.Plaintext) != string(bytesOf(32, 9)) {
		t.Fatalf("replay calls = generate %d decrypt %d save %d key %x", kms.generateCalls, kms.decryptCalls, repository.saveCalls, second.Plaintext)
	}
	if !reflect.DeepEqual(kms.decryptedContext, expectedContext) {
		t.Fatalf("decrypt context = %#v, want %#v", kms.decryptedContext, expectedContext)
	}
}

func TestServiceRejectsAuthorityMutationBeforeDecrypt(t *testing.T) {
	authority := testAuthority()
	kms := &kmsStub{generated: recordingkeys.GenerateDataKeyResult{Plaintext: bytesOf(32, 7), CiphertextBlob: []byte("ciphertext")}}
	repository := &repositoryStub{}
	service, err := recordingkeys.NewService(kms, repository, recordingkeys.Config{Environment: "test", KeyID: "kms"})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	if _, err := service.GetOrCreate(context.Background(), authority); err != nil {
		t.Fatalf("create key: %v", err)
	}
	mutated := authority
	mutated.EnvelopeDigest = bytesOf(32, 8)
	if _, err := service.GetOrCreate(context.Background(), mutated); !errors.Is(err, recordingkeys.ErrAuthorityMismatch) {
		t.Fatalf("mutated authority error = %v, want mismatch", err)
	}
	if kms.decryptCalls != 0 {
		t.Fatalf("decrypt calls = %d, want no decrypt on mismatch", kms.decryptCalls)
	}
}

func TestServiceConcurrentInsertConflictReplaysDurableKey(t *testing.T) {
	authority := testAuthority()
	kms := &kmsStub{generated: recordingkeys.GenerateDataKeyResult{Plaintext: bytesOf(32, 7), CiphertextBlob: []byte("new")}}
	repository := &repositoryStub{saveErr: recordingkeys.ErrKeyConflict, getExistingAfterSave: true, existing: recordingkeys.Record{
		Authority: authority, CiphertextBlob: []byte("existing"), EncryptionContext: authority.Context("test"), ContextDigest: authority.Context("test").Digest(),
	}}
	service, err := recordingkeys.NewService(kms, repository, recordingkeys.Config{Environment: "test", KeyID: "kms"})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	kms.decrypted = bytesOf(32, 3)
	key, err := service.GetOrCreate(context.Background(), authority)
	if err != nil {
		t.Fatalf("conflict replay: %v", err)
	}
	if kms.generateCalls != 1 || kms.decryptCalls != 1 || string(key.Plaintext) != string(bytesOf(32, 3)) {
		t.Fatalf("conflict replay = generate %d decrypt %d key %x", kms.generateCalls, kms.decryptCalls, key.Plaintext)
	}
}

func TestClearPlaintext(t *testing.T) {
	value := []byte("secret")
	recordingkeys.ClearPlaintext(value)
	for index, item := range value {
		if item != 0 {
			t.Fatalf("byte %d = %d, want zero", index, item)
		}
	}
}

type repositoryStub struct {
	record               *recordingkeys.Record
	existing             recordingkeys.Record
	saveErr              error
	saveCalls            int
	getExistingAfterSave bool
}

func (r *repositoryStub) Authorize(context.Context, recordingkeys.Authority) error { return nil }

func (r *repositoryStub) Get(_ context.Context, _ recordingkeys.Authority) (recordingkeys.Record, error) {
	if r.record != nil {
		return *r.record, nil
	}
	if len(r.existing.CiphertextBlob) > 0 && (r.saveCalls > 0 || !r.getExistingAfterSave) {
		return r.existing, nil
	}
	return recordingkeys.Record{}, recordingkeys.ErrKeyNotFound
}

func (r *repositoryStub) Save(_ context.Context, record recordingkeys.Record) error {
	r.saveCalls++
	if r.saveErr != nil {
		return r.saveErr
	}
	r.record = &record
	return nil
}

type kmsStub struct {
	generated        recordingkeys.GenerateDataKeyResult
	decrypted        []byte
	generateCalls    int
	decryptCalls     int
	generatedContext map[string]string
	decryptedContext map[string]string
}

func (k *kmsStub) GenerateDataKey(_ context.Context, _ string, encryptionContext map[string]string) (recordingkeys.GenerateDataKeyResult, error) {
	k.generateCalls++
	k.generatedContext = cloneMap(encryptionContext)
	return recordingkeys.GenerateDataKeyResult{Plaintext: append([]byte(nil), k.generated.Plaintext...), CiphertextBlob: append([]byte(nil), k.generated.CiphertextBlob...)}, nil
}

func (k *kmsStub) Decrypt(_ context.Context, _ string, _ []byte, encryptionContext map[string]string) ([]byte, error) {
	k.decryptCalls++
	k.decryptedContext = cloneMap(encryptionContext)
	return append([]byte(nil), k.decrypted...), nil
}

func cloneMap(value map[string]string) map[string]string {
	copyValue := make(map[string]string, len(value))
	for key, item := range value {
		copyValue[key] = item
	}
	return copyValue
}

func testAuthority() recordingkeys.Authority {
	return recordingkeys.Authority{
		TenantID: "00000000-0000-4000-8000-000000000001", EpisodeID: "00000000-0000-4000-8000-000000000002",
		RecordingID: "00000000-0000-4000-8000-000000000003", JobID: "00000000-0000-4000-8000-000000000004",
		KeyHandle: "00000000-0000-4000-8000-000000000005", AttemptCount: 1, FencingGeneration: 2, CaptureEpoch: 3,
		EnvelopeDigest: bytesOf(32, 1), LeaseToken: "lease-token", LeaseOwner: "recorder-1", LeaseExpiresAt: time.Unix(200, 0).UTC(),
	}
}

func bytesOf(length int, value byte) []byte {
	bytes := make([]byte, length)
	for index := range bytes {
		bytes[index] = value
	}
	return bytes
}
