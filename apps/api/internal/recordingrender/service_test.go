package recordingrender

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestResolveRenderInputSignsEveryExactObjectVersionWithinLease(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	authority := renderAuthorityForTest(t, now.Add(3*time.Minute))
	presentationDigest := digestForTest(0x41)
	stored := StoredInput{
		SchemaVersion:     InputSchemaVersion,
		TranscriptionMode: artifactpolicy.TranscriptionDisabled,
		Authority:         authority,
		Capture: []CaptureObject{{
			ObjectFacts:  ObjectFacts{ObjectKey: "capture/0.enc", ObjectVersion: "capture-v1", ObjectETag: "capture-etag", ContentType: "application/octet-stream", ByteSize: 1024, SHA256: digestForTest(0x11)},
			CaptureEpoch: authority.CaptureEpoch, CaptureJobID: idForTest(t, "10000000-0000-4000-8000-000000000010"), KeyHandle: authority.KeyHandle, EnvelopeDigest: digestForTest(0x12),
			SequenceNumber: 0, MonotonicStartMillis: 0, MonotonicEndMillis: 1000,
			MediaStartMillis: 0, MediaEndMillis: 1000, Codec: "opus",
		}},
		Presentation: Presentation{
			Handle: idForTest(t, "10000000-0000-4000-8000-000000000009"), SchemaVersion: PresentationSchemaVersion,
			ProfileVersion: "composite_720p_v1", DurationMillis: 1000, SHA256: presentationDigest, CaptureReadyAt: now.Add(-time.Minute),
			Object:        ObjectFacts{ObjectKey: "presentation/frozen.json", ObjectVersion: "presentation-v2", ObjectETag: "presentation-etag", ContentType: "application/vnd.chalk.recording-presentation+json;version=1", ByteSize: 512, SHA256: presentationDigest},
			AssetManifest: ObjectFacts{ObjectKey: "presentation/assets.json", ObjectVersion: "manifest-v3", ObjectETag: "manifest-etag", ContentType: "application/json", ByteSize: 128, SHA256: digestForTest(0x42)},
			Assets:        []ObjectFacts{{ObjectKey: "presentation/ui.js", ObjectVersion: "asset-v4", ObjectETag: "asset-etag", ContentType: "text/javascript", ByteSize: 256, SHA256: digestForTest(0x43)}},
		},
	}
	store := &renderStoreForTest{now: now}
	repository := &renderRepositoryForTest{stored: stored}
	service, err := NewService(objectstorage.NewService(store), renderKMSForTest{}, repository, Config{KeyID: "recording-key", GrantTTL: 10 * time.Minute, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	resolved, err := service.ResolveRenderInput(context.Background(), authority)
	if err != nil {
		t.Fatalf("ResolveRenderInput() error = %v", err)
	}
	if len(store.downloads) != 4 {
		t.Fatalf("download grants = %d, want 4", len(store.downloads))
	}
	wantVersions := []string{"capture-v1", "presentation-v2", "manifest-v3", "asset-v4"}
	for index, input := range store.downloads {
		if input.VersionID != wantVersions[index] {
			t.Errorf("download[%d].VersionID = %q, want %q", index, input.VersionID, wantVersions[index])
		}
		if input.ExpiresIn != 3*time.Minute {
			t.Errorf("download[%d].ExpiresIn = %s, want 3m", index, input.ExpiresIn)
		}
		if input.IfMatch == "" {
			t.Errorf("download[%d].IfMatch is empty", index)
		}
	}
	if resolved.Presentation.ObjectVersion != "presentation-v2" || resolved.Assets[0].ObjectVersion != "asset-v4" {
		t.Fatalf("resolved input did not preserve immutable object versions")
	}
	for _, mode := range []artifactpolicy.TranscriptionMode{
		artifactpolicy.TranscriptionDisabled, artifactpolicy.TranscriptionOnDemand,
		artifactpolicy.TranscriptionAutomatic, "", "unrecognized",
	} {
		repository.stored.TranscriptionMode = mode
		resolved, err := service.ResolveRenderInput(context.Background(), authority)
		if mode.Validate() != nil {
			if !errors.Is(err, ErrInputIncomplete) {
				t.Fatalf("invalid transcription mode %q error = %v", mode, err)
			}
			continue
		}
		if err != nil || resolved.TranscriptionMode != mode {
			t.Fatalf("resolved transcription mode = %q, want %q, error = %v", resolved.TranscriptionMode, mode, err)
		}
	}

}

func TestResolveRenderInputAllowsImmutableETagWithoutProviderVersion(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	authority := renderAuthorityForTest(t, now.Add(3*time.Minute))
	presentationDigest := digestForTest(0x41)
	stored := StoredInput{
		SchemaVersion:     InputSchemaVersion,
		TranscriptionMode: artifactpolicy.TranscriptionDisabled,
		Authority:         authority,
		Capture: []CaptureObject{{
			ObjectFacts:  ObjectFacts{ObjectKey: "capture/0.enc", ObjectETag: "capture-etag", ContentType: "application/octet-stream", ByteSize: 1024, SHA256: digestForTest(0x11)},
			CaptureEpoch: authority.CaptureEpoch, CaptureJobID: idForTest(t, "10000000-0000-4000-8000-000000000010"), KeyHandle: authority.KeyHandle, EnvelopeDigest: digestForTest(0x12),
			SequenceNumber: 0, MonotonicStartMillis: 0, MonotonicEndMillis: 1000,
			MediaStartMillis: 0, MediaEndMillis: 1000, Codec: "opus",
		}},
		Presentation: Presentation{
			Handle: idForTest(t, "10000000-0000-4000-8000-000000000009"), SchemaVersion: PresentationSchemaVersion,
			ProfileVersion: "composite_720p_v1", DurationMillis: 1000, SHA256: presentationDigest, CaptureReadyAt: now.Add(-time.Minute),
			Object:        ObjectFacts{ObjectKey: "presentation/frozen.json", ObjectETag: "presentation-etag", ContentType: "application/json", ByteSize: 512, SHA256: presentationDigest},
			AssetManifest: ObjectFacts{ObjectKey: "presentation/assets.json", ObjectETag: "manifest-etag", ContentType: "application/json", ByteSize: 128, SHA256: digestForTest(0x42)},
		},
	}
	store := &renderStoreForTest{now: now}
	service, err := NewService(objectstorage.NewService(store), renderKMSForTest{}, &renderRepositoryForTest{stored: stored}, Config{KeyID: "recording-key", GrantTTL: 10 * time.Minute, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	if _, err = service.ResolveRenderInput(context.Background(), authority); err != nil {
		t.Fatalf("ResolveRenderInput() error = %v", err)
	}
	if len(store.downloads) != 3 {
		t.Fatalf("download grants = %d, want 3", len(store.downloads))
	}
	for _, input := range store.downloads {
		if input.VersionID != "" {
			t.Fatalf("download version = %q, want empty", input.VersionID)
		}
	}
}

func TestAccessRenderKeySelectsCommittedHistoricalEpoch(t *testing.T) {
	t.Parallel()
	authority := renderAuthorityForTest(t, time.Now().UTC().Add(time.Minute))
	historicalKeyHandle := idForTest(t, "10000000-0000-4000-8000-000000000011")
	repository := &renderRepositoryForTest{encryptedKey: EncryptedKey{
		KeyHandle: historicalKeyHandle, CiphertextBlob: []byte("ciphertext"),
		Context: recordingkeys.EncryptionContext{RecordingID: authority.RecordingID.String(), CaptureEpoch: 2},
	}}
	service, err := NewService(objectstorage.NewService(&renderStoreForTest{}), renderKMSForTest{}, repository, Config{KeyID: "recording-key"})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	key, err := service.AccessRenderKey(context.Background(), AccessKeyInput{Authority: authority, CaptureEpoch: 2})
	if err != nil {
		t.Fatalf("AccessRenderKey() error = %v", err)
	}
	defer recordingkeys.ClearPlaintext(key.Plaintext)
	if repository.accessKeyInput.CaptureEpoch != 2 || !SameAuthority(repository.accessKeyInput.Authority, authority) || key.CaptureEpoch != 2 || key.KeyHandle != historicalKeyHandle || len(key.Plaintext) != 32 {
		t.Fatalf("historical key selection mismatch: input=%#v key=%#v", repository.accessKeyInput, key)
	}
}

func TestValidateStoredInputAllowsSequenceHolesAndRejectsDuplicates(t *testing.T) {
	t.Parallel()
	authority := renderAuthorityForTest(t, time.Now().UTC().Add(time.Minute))
	presentationDigest := digestForTest(0x41)
	stored := StoredInput{
		SchemaVersion:     InputSchemaVersion,
		TranscriptionMode: artifactpolicy.TranscriptionDisabled, Authority: authority,
		Presentation: Presentation{
			Handle: idForTest(t, "10000000-0000-4000-8000-000000000009"), SchemaVersion: PresentationSchemaVersion, ProfileVersion: "composite_720p_v1",
			DurationMillis: 1000, SHA256: presentationDigest, CaptureReadyAt: time.Now().UTC(),
			Object:        ObjectFacts{ObjectKey: "presentation/frozen.json", ObjectETag: "presentation-etag", ContentType: "application/json", ByteSize: 512, SHA256: presentationDigest},
			AssetManifest: ObjectFacts{ObjectKey: "presentation/assets.json", ObjectETag: "manifest-etag", ContentType: "application/json", ByteSize: 128, SHA256: digestForTest(0x42)},
		},
	}
	captureJobID := idForTest(t, "10000000-0000-4000-8000-000000000010")
	object := func(sequence int64) CaptureObject {
		return CaptureObject{
			ObjectFacts:  ObjectFacts{ObjectKey: "capture/object.enc", ObjectETag: "capture-etag", ContentType: "application/octet-stream", ByteSize: 128, SHA256: digestForTest(byte(sequence + 1))},
			CaptureEpoch: authority.CaptureEpoch, CaptureJobID: captureJobID, KeyHandle: authority.KeyHandle, EnvelopeDigest: digestForTest(0x12),
			SequenceNumber: sequence, MonotonicEndMillis: 100, MediaEndMillis: 100, Codec: "opus",
		}
	}
	stored.Capture = []CaptureObject{object(0), object(2)}
	if err := validateStoredInput(stored); err != nil {
		t.Fatalf("validateStoredInput() rejected committed sequence hole: %v", err)
	}
	stored.Capture[1].SequenceNumber = 0
	if err := validateStoredInput(stored); err == nil {
		t.Fatal("validateStoredInput() accepted duplicate sequence")
	}
	stored.Capture[1].SequenceNumber = 2
	stored.Capture[0].KeyHandle = idForTest(t, "10000000-0000-4000-8000-000000000011")
	stored.Capture[1].KeyHandle = stored.Capture[0].KeyHandle
	if err := validateStoredInput(stored); err != ErrAuthorityMismatch {
		t.Fatalf("validateStoredInput() current key substitution error = %v, want %v", err, ErrAuthorityMismatch)
	}
}

func TestCommitValidationBindsDigestAndTranscriptionFence(t *testing.T) {
	t.Parallel()
	input := commitInputForTest(t)
	digest, err := CommitDigest(input)
	if err != nil {
		t.Fatalf("CommitDigest() error = %v", err)
	}
	input.CommitDigest = digest
	if err := input.Validate(); err != nil {
		t.Fatalf("valid commit rejected: %v", err)
	}

	input.TranscriptionSource.Chunks[0].Generation++
	if err := input.Validate(); err == nil {
		t.Fatal("commit with transcription generation outside the render fence was accepted")
	}
}

func TestCommitValidationRejectsTranscriptionChunkOutsidePresentation(t *testing.T) {
	t.Parallel()
	input := commitInputForTest(t)
	chunkDuration := input.DurationMillis + 1
	input.TranscriptionSource.Chunks[0].EndMillis = chunkDuration
	input.TranscriptionSource.Chunks[0].SourceEndMillis = chunkDuration
	input.TranscriptionSource.Chunks[0].Object.DurationMillis = &chunkDuration
	digest, err := CommitDigest(input)
	if err != nil {
		t.Fatalf("CommitDigest() error = %v", err)
	}
	input.CommitDigest = digest
	if err := input.Validate(); err == nil {
		t.Fatal("commit with transcription chunk beyond the presentation duration was accepted")
	}
}

func TestCommitRenderObjectAllowsImmutableETagWithoutProviderVersion(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	authority := renderAuthorityForTest(t, now.Add(time.Minute))
	allocationID := idForTest(t, "20000000-0000-4000-8000-000000000009")
	digest := digestForTest(0x72)
	expiresAt := now.Add(time.Minute)
	allocation := Allocation{
		ID: allocationID, Authority: authority, Purpose: PurposeRecordingVideo, State: "allocated",
		Object: ObjectFacts{ObjectKey: "render/video.mp4"}, ExpectedContentType: "video/mp4",
		ExpectedByteSize: 128, ExpectedSHA256: digest, UploadExpiresAt: &expiresAt,
	}
	facts := objectstorage.ObjectFacts{Object: objectstorage.Object{
		Key: "render/video.mp4", ETag: "immutable-etag", ContentType: "video/mp4", Size: 128,
		ChecksumSHA256: base64.StdEncoding.EncodeToString(digest),
	}}
	repository := &renderRepositoryForTest{allocation: allocation}
	store := &renderStoreForTest{now: now, facts: facts}
	service, err := NewService(objectstorage.NewService(store), renderKMSForTest{}, repository, Config{KeyID: "recording-key", Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	if _, err := service.CommitRenderObject(context.Background(), CommitObjectInput{Authority: authority, AllocationID: allocationID, UploadToken: "upload-token"}); err != nil {
		t.Fatalf("CommitRenderObject() error = %v", err)
	}
}

func TestCommitRenderWakesOnlyPersistedTranscriptionJobs(t *testing.T) {
	t.Parallel()
	input := commitInputForTest(t)
	digest, err := CommitDigest(input)
	if err != nil {
		t.Fatalf("CommitDigest() error = %v", err)
	}
	input.CommitDigest = digest
	firstJob := idForTest(t, "20000000-0000-4000-8000-000000000005")
	secondJob := idForTest(t, "20000000-0000-4000-8000-000000000006")
	repository := &renderRepositoryForTest{commitResult: CommitResult{Transcription: &TranscriptionResult{SourceID: input.Authority.RecordingID, JobIDs: []utilities.ID{firstJob, secondJob}}}}
	woken := make([]utilities.ID, 0, 2)
	service, err := NewService(objectstorage.NewService(&renderStoreForTest{}), renderKMSForTest{}, repository, Config{
		KeyID: "recording-key", Wake: func(_ context.Context, jobID utilities.ID) { woken = append(woken, jobID) },
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	if _, err := service.CommitRender(context.Background(), input); err != nil {
		t.Fatalf("CommitRender() error = %v", err)
	}
	if len(woken) != 2 || woken[0] != firstJob || woken[1] != secondJob {
		t.Fatalf("woken jobs = %v, want [%s %s]", woken, firstJob, secondJob)
	}
}

func TestPurposeFactsAreStrictlyScoped(t *testing.T) {
	t.Parallel()
	duration := int64(1000)
	tests := []struct {
		name        string
		purpose     ObjectPurpose
		contentType string
		duration    *int64
		wantError   bool
	}{
		{name: "video", purpose: PurposeRecordingVideo, contentType: "video/mp4", duration: &duration},
		{name: "video wrong mime", purpose: PurposeRecordingVideo, contentType: "video/webm", duration: &duration, wantError: true},
		{name: "manifest", purpose: PurposeTranscriptionManifest, contentType: "application/json"},
		{name: "manifest duration", purpose: PurposeTranscriptionManifest, contentType: "application/json", duration: &duration, wantError: true},
		{name: "audio", purpose: PurposeTranscriptionAudio, contentType: "audio/flac", duration: &duration},
		{name: "audio wrong mime", purpose: PurposeTranscriptionAudio, contentType: "audio/wav", duration: &duration, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validatePurposeFacts(test.purpose, test.contentType, 128, test.duration)
			if (err != nil) != test.wantError {
				t.Fatalf("validatePurposeFacts() error = %v, wantError %v", err, test.wantError)
			}
		})
	}
}

func renderAuthorityForTest(t *testing.T, leaseExpiresAt time.Time) Authority {
	t.Helper()
	return Authority{
		TenantID: idForTest(t, "10000000-0000-4000-8000-000000000001"), SpaceID: idForTest(t, "10000000-0000-4000-8000-000000000002"),
		EpisodeID: idForTest(t, "10000000-0000-4000-8000-000000000003"), RecordingID: idForTest(t, "10000000-0000-4000-8000-000000000004"),
		JobID: idForTest(t, "10000000-0000-4000-8000-000000000005"), RenderInputHandle: idForTest(t, "10000000-0000-4000-8000-000000000006"),
		KeyHandle: idForTest(t, "10000000-0000-4000-8000-000000000007"), ObjectHandle: idForTest(t, "10000000-0000-4000-8000-000000000008"),
		AttemptCount: 2, FencingGeneration: 7, CaptureEpoch: 3, EnvelopeDigest: digestForTest(0x51),
		LeaseToken: "lease-token", LeaseOwner: "render-worker", LeaseExpiresAt: leaseExpiresAt,
	}
}

func commitInputForTest(t *testing.T) CommitInput {
	t.Helper()
	authority := renderAuthorityForTest(t, time.Now().UTC().Add(time.Hour))
	duration := int64(1000)
	object := func(id, key, version, etag, contentType string, digestByte byte, purpose ObjectPurpose, objectDuration *int64) CommitObjectReference {
		return CommitObjectReference{AllocationID: idForTest(t, id), Purpose: purpose, Object: ObjectFacts{ObjectKey: key, ObjectVersion: version, ObjectETag: etag, ContentType: contentType, ByteSize: 128, SHA256: digestForTest(digestByte)}, DurationMillis: objectDuration}
	}
	presentationDigest := digestForTest(0x61)
	return CommitInput{
		Authority: authority, PresentationSHA256: presentationDigest, DurationMillis: duration,
		Video:              object("20000000-0000-4000-8000-000000000001", "render/video.mp4", "video-v1", "video-etag", "video/mp4", 0x62, PurposeRecordingVideo, &duration),
		FFprobeFactsDigest: digestForTest(0x63),
		TranscriptionSource: &TranscriptionSource{
			SchemaVersion: TranscriptionSourceSchemaVersion, PresentationSHA256: presentationDigest,
			Manifest: object("20000000-0000-4000-8000-000000000002", "render/transcription.json", "manifest-v1", "manifest-etag", "application/json", 0x64, PurposeTranscriptionManifest, nil),
			Chunks: []TranscriptionChunk{{
				ChunkID: idForTest(t, "20000000-0000-4000-8000-000000000003"), Index: 0, Generation: authority.FencingGeneration,
				StartMillis: 0, EndMillis: 1000, SourceStartMillis: 0, SourceEndMillis: 1000,
				ParticipantRef: "participant-1", ParticipantGeneration: 1, DisplayNameSnapshot: "Speaker",
				TrackID: "audio-track", TrackEpoch: "track-epoch-1", IdentityKind: "participant", TrackClass: "microphone",
				Object: object("20000000-0000-4000-8000-000000000004", "render/audio.flac", "audio-v1", "audio-etag", "audio/flac", 0x65, PurposeTranscriptionAudio, &duration),
			}},
		},
	}
}

func idForTest(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("ParseID(%q): %v", value, err)
	}
	return id
}

func digestForTest(value byte) []byte {
	return []byte{value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value, value}
}

type renderRepositoryForTest struct {
	stored         StoredInput
	allocation     Allocation
	commitResult   CommitResult
	preparation    *TranscriptionResult
	encryptedKey   EncryptedKey
	accessKeyInput AccessKeyInput
}

func (r *renderRepositoryForTest) ResolveInput(context.Context, Authority) (StoredInput, error) {
	return r.stored, nil
}
func (r *renderRepositoryForTest) GetCaptureKey(_ context.Context, input AccessKeyInput) (EncryptedKey, error) {
	r.accessKeyInput = input
	return r.encryptedKey, nil
}
func (*renderRepositoryForTest) ReserveObject(context.Context, ReserveObjectInput, utilities.ID, string, time.Time) (Allocation, error) {
	return Allocation{}, nil
}
func (*renderRepositoryForTest) GetObjectAllocation(context.Context, Authority, utilities.ID) (Allocation, error) {
	return Allocation{}, nil
}
func (*renderRepositoryForTest) FinalizeObject(context.Context, Allocation) (Allocation, error) {
	return Allocation{}, nil
}
func (r *renderRepositoryForTest) GetObjectAllocationByTokenHash(context.Context, Authority, []byte) (Allocation, error) {
	return r.allocation, nil
}
func (*renderRepositoryForTest) CommitObject(context.Context, Allocation, objectstorage.ObjectFacts, time.Time) (CommittedObject, error) {
	return CommittedObject{}, nil
}
func (r *renderRepositoryForTest) Commit(context.Context, CommitInput, time.Time) (CommitResult, error) {
	return r.commitResult, nil
}
func (r *renderRepositoryForTest) CommitTranscriptionPreparation(context.Context, TranscriptionPreparationInput, time.Time) (*TranscriptionResult, error) {
	return r.preparation, nil
}

type renderKMSForTest struct{}

func (renderKMSForTest) GenerateDataKey(context.Context, string, map[string]string) (recordingkeys.GenerateDataKeyResult, error) {
	return recordingkeys.GenerateDataKeyResult{}, nil
}
func (renderKMSForTest) Decrypt(context.Context, string, []byte, map[string]string) ([]byte, error) {
	return make([]byte, 32), nil
}

type renderStoreForTest struct {
	now       time.Time
	downloads []objectstorage.CreateDownloadURLInput
	facts     objectstorage.ObjectFacts
}

func (*renderStoreForTest) PutObject(context.Context, objectstorage.PutObjectInput) (objectstorage.Object, error) {
	return objectstorage.Object{}, nil
}
func (*renderStoreForTest) GetObject(context.Context, string) (objectstorage.ObjectReader, error) {
	return objectstorage.ObjectReader{}, nil
}
func (s *renderStoreForTest) InspectObject(context.Context, string) (objectstorage.ObjectFacts, error) {
	return s.facts, nil
}
func (*renderStoreForTest) DeleteObject(context.Context, string) error { return nil }
func (*renderStoreForTest) CreateUploadURL(context.Context, objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, nil
}
func (s *renderStoreForTest) CreateDownloadURL(_ context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	s.downloads = append(s.downloads, input)
	return objectstorage.SignedURL{Method: "GET", URL: "https://objects.example/download", SignedAt: s.now, ExpiresAt: s.now.Add(input.ExpiresIn)}, nil
}
func (*renderStoreForTest) CreateDeleteURL(context.Context, objectstorage.CreateDeleteURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, nil
}
