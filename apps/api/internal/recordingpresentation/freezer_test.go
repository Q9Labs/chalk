package recordingpresentation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPrepareFreezesReferencedAssetsBeforePublishingTimeline(t *testing.T) {
	t.Parallel()

	body := []byte("attachment needed by the recording")
	digest := sha256.Sum256(body)
	store := newPresentationMemoryStore()
	store.objects["episode/chat/source"] = storedPresentationObject{
		body: body,
		object: objectstorage.Object{
			Key: "episode/chat/source", ETag: `"source-etag"`,
			ContentType: "image/png", Size: int64(len(body)),
		},
	}
	readyAt := time.Date(2026, time.September, 6, 12, 0, 0, 0, time.UTC)
	participantID := "00000000-0000-4000-8000-000000000105"
	profile, err := NewComposite720PProfile(strings.Repeat("a", 64))
	if err != nil {
		t.Fatalf("build profile: %v", err)
	}
	source := CompletionSource{
		PresentationHandle: testPresentationID(t, "00000000-0000-4000-8000-000000000101"),
		TenantID:           testPresentationID(t, "00000000-0000-4000-8000-000000000102"),
		SpaceID:            testPresentationID(t, "00000000-0000-4000-8000-000000000103"),
		EpisodeID:          testPresentationID(t, "00000000-0000-4000-8000-000000000104"),
		RecordingID:        testPresentationID(t, "00000000-0000-4000-8000-000000000106"),
		CaptureEpoch:       4,
		CaptureReadyAt:     readyAt,
		DurationMillis:     5_000,
		Profile:            profile,
		SpaceName:          "Recorded space",
		ChatStartSequence:  1,
		InitialChatMessages: []ChatMessageFact{{
			ID: "00000000-0000-4000-8000-000000000107", Sequence: 1,
			ParticipantID: participantID, ParticipantGeneration: 1,
			DisplayName: "Participant", Text: "See this", CreatedAt: readyAt,
			Attachments: []ChatAttachmentFact{{
				ID: "00000000-0000-4000-8000-000000000108", FileName: "reference.png",
				Object: ObjectFact{
					Key: "episode/chat/source", ETag: `"source-etag"`, ContentType: "image/png",
					ByteSize: int64(len(body)), SHA256: digest[:],
				},
			}},
		}},
		BaselineControlState: []byte(fmt.Sprintf(
			`{"control_revision":0,"participants":[{"participant_id":%q,"display_name":"Participant","hand_raised":false,"admission_revision":1}]}`,
			participantID,
		)),
	}
	authority := CompletionAuthority{
		JobID:        testPresentationID(t, "00000000-0000-4000-8000-000000000109"),
		AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: source.CaptureEpoch,
		EnvelopeDigest: bytes.Repeat([]byte{0x7a}, sha256.Size),
		LeaseToken:     "lease-token", LeaseOwner: "recorder-one",
	}
	freezer, err := NewFreezer(staticCompletionSourceReader{source: source}, store)
	if err != nil {
		t.Fatalf("new freezer: %v", err)
	}

	prepared, err := freezer.Prepare(context.Background(), authority)
	if err != nil {
		t.Fatalf("prepare presentation: %v", err)
	}
	if len(prepared.Assets) != 1 {
		t.Fatalf("prepared asset count = %d, want 1", len(prepared.Assets))
	}
	frozenKey := prepared.Assets[0].Object.Key
	if frozenKey == "episode/chat/source" || !strings.HasPrefix(frozenKey, presentationObjectPrefix(source)+"/assets/") {
		t.Fatalf("prepared asset key = %q, want recording presentation namespace", frozenKey)
	}
	timeline := store.objects[prepared.PresentationObject.Key].body
	decoded, err := Decode(timeline)
	if err != nil {
		t.Fatalf("decode frozen timeline: %v", err)
	}
	if len(decoded.Assets) != 1 || decoded.Assets[0].ObjectKey != frozenKey {
		t.Fatalf("timeline assets = %#v, want frozen key %q", decoded.Assets, frozenKey)
	}

	delete(store.objects, "episode/chat/source")
	retried, err := freezer.Prepare(context.Background(), authority)
	if err != nil {
		t.Fatalf("retry prepare after source cleanup: %v", err)
	}
	if retried.Assets[0].Object.Key != frozenKey || retried.PresentationObject.Key != prepared.PresentationObject.Key {
		t.Fatalf("retry changed immutable presentation: first=%#v retry=%#v", prepared, retried)
	}
}

func TestCopyExistingCanonicalSurvivesSourceCleanup(t *testing.T) {
	t.Parallel()

	body := []byte("durable attachment bytes")
	digest := sha256.Sum256(body)
	store := newPresentationMemoryStore()
	store.objects["episode/chat/source"] = storedPresentationObject{
		body: body,
		object: objectstorage.Object{
			Key: "episode/chat/source", ETag: `"source-etag"`,
			ContentType: "image/png", Size: int64(len(body)),
		},
	}
	source := CompletionSource{
		PresentationHandle: testPresentationID(t, "00000000-0000-4000-8000-000000000001"),
		TenantID:           testPresentationID(t, "00000000-0000-4000-8000-000000000002"),
		RecordingID:        testPresentationID(t, "00000000-0000-4000-8000-000000000003"),
		CaptureEpoch:       7,
	}
	expected := ObjectFact{
		Key: "episode/chat/source", ETag: `"source-etag"`, ContentType: "image/png",
		ByteSize: int64(len(body)), SHA256: digest[:],
	}
	destination := existingAssetObjectKey(source, "chat_attachment:one", "chat_attachment", fmt.Sprintf("%x", digest))
	freezer := Freezer{objects: store}

	first, err := freezer.copyExistingCanonical(context.Background(), source, destination, expected)
	if err != nil {
		t.Fatalf("copy existing object: %v", err)
	}
	if first.Key != destination || bytes.Equal([]byte(first.Key), []byte(expected.Key)) {
		t.Fatalf("frozen object key = %q, want recording-owned %q", first.Key, destination)
	}
	delete(store.objects, expected.Key)

	second, err := freezer.copyExistingCanonical(context.Background(), source, destination, expected)
	if err != nil {
		t.Fatalf("retry after source cleanup: %v", err)
	}
	if second.Key != destination || !bytes.Equal(second.SHA256, expected.SHA256) {
		t.Fatalf("retried frozen facts = %#v", second)
	}
	if got := store.objects[destination].body; !bytes.Equal(got, body) {
		t.Fatalf("frozen bytes = %q, want %q", got, body)
	}
}

func TestCopyExistingCanonicalRejectsUnverifiedSourceBytes(t *testing.T) {
	t.Parallel()

	expectedBody := []byte("right")
	actualBody := []byte("wrong")
	digest := sha256.Sum256(expectedBody)
	store := newPresentationMemoryStore()
	store.objects["episode/whiteboard/source"] = storedPresentationObject{
		body: actualBody,
		object: objectstorage.Object{
			Key: "episode/whiteboard/source", ETag: `"source-etag"`,
			ContentType: "image/png", Size: int64(len(actualBody)),
		},
	}
	source := CompletionSource{
		PresentationHandle: testPresentationID(t, "00000000-0000-4000-8000-000000000011"),
		TenantID:           testPresentationID(t, "00000000-0000-4000-8000-000000000012"),
		RecordingID:        testPresentationID(t, "00000000-0000-4000-8000-000000000013"),
		CaptureEpoch:       9,
	}
	expected := ObjectFact{
		Key: "episode/whiteboard/source", ETag: `"source-etag"`, ContentType: "image/png",
		ByteSize: int64(len(expectedBody)), SHA256: digest[:],
	}
	destination := existingAssetObjectKey(source, "whiteboard_file:one", "whiteboard_file", fmt.Sprintf("%x", digest))
	freezer := Freezer{objects: store}

	if _, err := freezer.copyExistingCanonical(context.Background(), source, destination, expected); err != ErrObjectFactsMismatch {
		t.Fatalf("copy error = %v, want %v", err, ErrObjectFactsMismatch)
	}
	if _, exists := store.objects[destination]; exists {
		t.Fatal("unverified bytes were published into the recording namespace")
	}
}

type storedPresentationObject struct {
	body   []byte
	object objectstorage.Object
}

type presentationMemoryStore struct {
	objects    map[string]storedPresentationObject
	putVersion string
	getVersion string
}

type staticCompletionSourceReader struct {
	source CompletionSource
}

func (reader staticCompletionSourceReader) LoadCompletionSource(context.Context, CompletionAuthority) (CompletionSource, error) {
	return reader.source, nil
}

func newPresentationMemoryStore() *presentationMemoryStore {
	return &presentationMemoryStore{objects: make(map[string]storedPresentationObject)}
}

func (store *presentationMemoryStore) PutObject(_ context.Context, input objectstorage.PutObjectInput) (objectstorage.Object, error) {
	if input.IfNoneMatch {
		if _, exists := store.objects[input.Key]; exists {
			return objectstorage.Object{}, objectstorage.ErrObjectAlreadyExists
		}
	}
	body, err := io.ReadAll(input.Body)
	if err != nil {
		return objectstorage.Object{}, err
	}
	if int64(len(body)) != input.ContentLength {
		return objectstorage.Object{}, objectstorage.ErrInvalidObjectSize
	}
	digest := sha256.Sum256(body)
	object := objectstorage.Object{
		Key: input.Key, ETag: fmt.Sprintf(`"%x"`, digest[:8]),
		ContentType: input.ContentType, Size: input.ContentLength,
	}
	store.objects[input.Key] = storedPresentationObject{body: append([]byte(nil), body...), object: object}
	object.VersionID = store.putVersion
	return object, nil
}

func (store *presentationMemoryStore) GetObject(_ context.Context, key string) (objectstorage.ObjectReader, error) {
	stored, exists := store.objects[key]
	if !exists {
		return objectstorage.ObjectReader{}, objectstorage.ErrObjectNotFound
	}
	stored.object.VersionID = store.getVersion
	return objectstorage.ObjectReader{
		Object: stored.object,
		Body:   io.NopCloser(bytes.NewReader(stored.body)),
	}, nil
}

func testPresentationID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}

func TestCanonicalObjectUsesVerifiedReadVersionWhenPutVersionIsNotReadable(t *testing.T) {
	for _, test := range []struct {
		name, putVersion, getVersion string
		mismatch                     bool
	}{
		{"R2 opaque write version", "opaque-write-generation", "", false},
		{"versioned storage", "version-1", "version-1", false},
		{"changed readable version", "version-1", "version-2", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := newPresentationMemoryStore()
			store.putVersion, store.getVersion = test.putVersion, test.getVersion
			freezer := Freezer{objects: store}
			fact, err := freezer.putCanonical(context.Background(), CompletionSource{}, "recording/timeline.json", "application/json", []byte(`{"timeline":true}`))
			if test.mismatch {
				if !errors.Is(err, ErrObjectFactsMismatch) {
					t.Fatalf("changed object version error = %v", err)
				}
				return
			}
			if err != nil || fact.Version != test.getVersion {
				t.Fatalf("canonical object = %+v, error = %v", fact, err)
			}
		})
	}
}
