package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestProductionRenderAttemptPreparesTranscriptionWithoutRenderOutput(t *testing.T) {
	for _, test := range []struct {
		name               string
		mode               artifactpolicy.TranscriptionMode
		commitErr          error
		wantDisabledReject bool
	}{
		{name: "automatic commits microphone source", mode: artifactpolicy.TranscriptionAutomatic},
		{name: "on-demand commits microphone source", mode: artifactpolicy.TranscriptionOnDemand},
		{name: "disabled rejects preparation", mode: artifactpolicy.TranscriptionDisabled, wantDisabledReject: true},
		{name: "reports transcription commit error", mode: artifactpolicy.TranscriptionAutomatic, commitErr: errors.New("transcription commit refused")},
	} {
		t.Run(test.name, func(t *testing.T) {
			attempt, control, decode := transcriptionAttemptForTest(t, test.mode, test.commitErr)
			observer := &transcriptionAttemptObserver{}
			attempt.config.Observer = observer
			err := attempt.Run(context.Background())
			if test.wantDisabledReject {
				if !errors.Is(err, ErrInvalidProductionRenderAttempt) || attempt.committed || control.transcriptionInput != nil || decode.microphoneOnly {
					t.Fatalf("disabled preparation error=%v committed=%t input=%#v decoded=%t", err, attempt.committed, control.transcriptionInput, decode.microphoneOnly)
				}
				return
			}
			if test.commitErr != nil {
				if !errors.Is(err, test.commitErr) || attempt.committed {
					t.Fatalf("Run() error = %v, committed=%t", err, attempt.committed)
				}
				return
			}
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if !attempt.committed || control.transcriptionInput == nil || control.transcriptionInput.TranscriptionSource == nil {
				t.Fatalf("transcription preparation was not committed: committed=%t input=%#v", attempt.committed, control.transcriptionInput)
			}
			if len(control.transcriptionInput.TranscriptionSource.Chunks) != 1 || len(control.videoPurposes) != 0 {
				t.Fatalf("prepared source=%#v video allocations=%v", control.transcriptionInput.TranscriptionSource, control.videoPurposes)
			}
			if !decode.microphoneOnly {
				t.Fatal("transcription preparation did not limit decode to microphone sources")
			}
			assertTranscriptionPreparationStages(t, observer.stages)
		})
	}
}

type transcriptionAttemptObserver struct {
	stages []RenderAttemptStageMeasurement
}

func (observer *transcriptionAttemptObserver) ObserveRenderAttemptStage(measurement RenderAttemptStageMeasurement) {
	observer.stages = append(observer.stages, measurement)
}

func (*transcriptionAttemptObserver) ObserveRenderFrameEncoding(RenderFrameEncodingMeasurement) {}

func assertTranscriptionPreparationStages(t *testing.T, measurements []RenderAttemptStageMeasurement) {
	t.Helper()
	want := []RenderAttemptStage{
		RenderAttemptStageResolveInput,
		RenderAttemptStageDownloadPresentation,
		RenderAttemptStageDownloadCapture,
		RenderAttemptStageAccessCaptureKeys,
		RenderAttemptStageSourcePreparation,
		RenderAttemptStagePersistTranscription,
		RenderAttemptStageCommit,
	}
	if len(measurements) != len(want) {
		t.Fatalf("transcription stage measurements = %#v", measurements)
	}
	for index, stage := range want {
		measurement := measurements[index]
		if measurement.Stage != stage || !measurement.Succeeded || measurement.WallDuration < 0 {
			t.Fatalf("transcription stage %d = %#v, want successful %q", index, measurement, stage)
		}
	}
}

type transcriptionAttemptDecode struct {
	microphoneOnly bool
}

func (decode *transcriptionAttemptDecode) write(_ context.Context, request recordingdecode.Request) (recordingdecode.Result, error) {
	decode.microphoneOnly = len(request.IncludedSourceKinds) == 1 && request.IncludedSourceKinds[0] == recordingpresentation.MediaKindMicrophone
	if !decode.microphoneOnly {
		return recordingdecode.Result{}, errors.New("decode was not restricted to microphone media")
	}
	mediaDirectory := filepath.Join(request.OutputDirectory, "media")
	if err := os.MkdirAll(mediaDirectory, 0o700); err != nil {
		return recordingdecode.Result{}, err
	}
	path := filepath.Join(mediaDirectory, "microphone.wav")
	if err := os.WriteFile(path, []byte("source audio"), 0o600); err != nil {
		return recordingdecode.Result{}, err
	}
	return recordingdecode.Result{Index: recordingdecode.Index{Sources: []recordingdecode.Source{{
		SourceID: "microphone-1", ParticipantID: "00000000-0000-4000-8000-000000000005", ParticipantGeneration: 1,
		TrackID: "microphone-track", TrackEpoch: 1, Kind: "microphone", Path: "media/microphone.wav", StartMS: 0, EndMS: 1_000,
	}}}}, nil
}

type transcriptionAttemptCommands struct{}

func (transcriptionAttemptCommands) Run(_ context.Context, name string, arguments ...string) ([]byte, error) {
	switch name {
	case "ffmpeg":
		if len(arguments) == 0 {
			return nil, errors.New("missing FLAC output path")
		}
		if err := os.WriteFile(arguments[len(arguments)-1], []byte("flac audio"), 0o600); err != nil {
			return nil, err
		}
		return nil, nil
	case "ffprobe":
		return []byte(`{"streams":[{"codec_type":"audio","codec_name":"flac","sample_rate":"16000","channels":1}],"format":{"duration":"1.000"}}`), nil
	default:
		return nil, fmt.Errorf("unexpected media command %q", name)
	}
}

type transcriptionAttemptControl struct {
	RenderAuthorityPort
	input              recordingrender.ResolvedInput
	presentation       []byte
	keyHandle          utilities.ID
	commitErr          error
	allocationCount    int
	allocations        map[utilities.ID]recordingrender.FinalizeObjectInput
	reserved           map[utilities.ID]recordingrender.ReservedObject
	videoPurposes      []recordingrender.ObjectPurpose
	transcriptionInput *recordingrender.TranscriptionPreparationInput
}

func (control *transcriptionAttemptControl) ResolveRenderInput(context.Context, recordingrender.Authority) (recordingrender.ResolvedInput, error) {
	return control.input, nil
}

func (control *transcriptionAttemptControl) DownloadRenderObject(_ context.Context, object recordingrender.DownloadableObject, outputPath string) error {
	contents := []byte("encrypted bundle")
	if object.ObjectKey == control.input.Presentation.ObjectKey {
		contents = control.presentation
	}
	return os.WriteFile(outputPath, contents, 0o600)
}

func (control *transcriptionAttemptControl) AccessRenderKey(_ context.Context, input recordingrender.AccessKeyInput) (recordingrender.DataKey, error) {
	return recordingrender.DataKey{KeyHandle: control.keyHandle, CaptureEpoch: input.CaptureEpoch, Plaintext: bytes.Repeat([]byte{0x5a}, 32)}, nil
}

func (control *transcriptionAttemptControl) ReserveRenderObject(_ context.Context, input recordingrender.ReserveObjectInput) (recordingrender.ReservedObject, error) {
	if input.Purpose == recordingrender.PurposeRecordingVideo {
		control.videoPurposes = append(control.videoPurposes, input.Purpose)
		return recordingrender.ReservedObject{}, errors.New("video allocation reached")
	}
	control.allocationCount++
	id, err := utilities.ParseID(fmt.Sprintf("00000000-0000-4000-8000-%012d", control.allocationCount))
	if err != nil {
		return recordingrender.ReservedObject{}, err
	}
	if control.reserved == nil {
		control.reserved = make(map[utilities.ID]recordingrender.ReservedObject)
	}
	reserved := recordingrender.ReservedObject{AllocationID: id, ObjectKey: "recordings/test/transcription-" + fmt.Sprint(control.allocationCount), Purpose: input.Purpose, AllocationVersion: 1}
	control.reserved[id] = reserved
	return reserved, nil
}

func (control *transcriptionAttemptControl) FinalizeRenderObject(_ context.Context, input recordingrender.FinalizeObjectInput) (recordingrender.FinalizedObject, error) {
	if control.allocations == nil {
		control.allocations = make(map[utilities.ID]recordingrender.FinalizeObjectInput)
	}
	reserved, exists := control.reserved[input.AllocationID]
	if !exists || reserved.Purpose != input.Purpose {
		return recordingrender.FinalizedObject{}, errors.New("unknown transcription reservation")
	}
	control.allocations[input.AllocationID] = input
	return recordingrender.FinalizedObject{ReservedObject: reserved, UploadToken: "upload-token", Upload: objectstorage.SignedURL{Method: "PUT"}}, nil
}

func (control *transcriptionAttemptControl) UploadRenderObject(_ context.Context, _ objectstorage.SignedURL, reader io.Reader, byteSize int64) error {
	contents, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	if int64(len(contents)) != byteSize {
		return errors.New("transcription upload length mismatch")
	}
	return nil
}

func (control *transcriptionAttemptControl) CommitRenderObject(_ context.Context, input recordingrender.CommitObjectInput) (recordingrender.CommittedObject, error) {
	finalized, exists := control.allocations[input.AllocationID]
	if !exists {
		return recordingrender.CommittedObject{}, errors.New("unknown transcription allocation")
	}
	reserved := control.reserved[input.AllocationID]
	return recordingrender.CommittedObject{ReservedObject: reserved, Object: recordingrender.ObjectFacts{ObjectKey: reserved.ObjectKey, ObjectETag: "etag", ContentType: finalized.ContentType, ByteSize: finalized.ByteSize, SHA256: append([]byte(nil), finalized.SHA256...)}, DurationMillis: finalized.DurationMillis}, nil
}

func (control *transcriptionAttemptControl) CommitTranscriptionPreparation(_ context.Context, input recordingrender.TranscriptionPreparationInput) (*recordingrender.TranscriptionResult, error) {
	control.transcriptionInput = &input
	if err := input.Validate(); err != nil {
		return nil, err
	}
	if control.commitErr != nil {
		return nil, control.commitErr
	}
	return &recordingrender.TranscriptionResult{SourceID: input.Authority.RecordingID}, nil
}

func transcriptionAttemptForTest(t *testing.T, mode artifactpolicy.TranscriptionMode, commitErr error) (*ProductionRenderAttempt, *transcriptionAttemptControl, *transcriptionAttemptDecode) {
	t.Helper()
	now := time.Date(2026, time.September, 21, 18, 0, 0, 0, time.UTC)
	presentation, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contract", "schema", "fixtures", "recording-presentation-v1", "minimal-valid.json"))
	if err != nil {
		t.Fatal(err)
	}
	timeline, err := recordingpresentation.Decode(presentation)
	if err != nil {
		t.Fatal(err)
	}
	presentationHash := sha256.Sum256(presentation)
	claim := ClaimResult{
		ClaimRequestID: mustRenderAttemptID(t, "11111111-1111-4111-8111-111111111111"),
		Envelope: recordingpipeline.RecorderJobEnvelope{
			TenantID: "22222222-2222-4222-8222-222222222222", SpaceID: timeline.Initial.Space.ID, EpisodeID: timeline.EpisodeID, RecordingID: timeline.RecordingID,
			JobID: "66666666-6666-4666-8666-666666666666", Kind: recordingpipeline.JobKindTranscription, AttemptCount: 2, FencingGeneration: 3, CaptureEpoch: timeline.Clock.CaptureEpoch,
			CaptureReadyAt: pointerString(now.Add(-time.Minute).Format(time.RFC3339Nano)), HardDeadline: now.Add(30 * time.Minute).Format(time.RFC3339Nano),
			RenderInputHandle: "77777777-7777-4777-8777-777777777777", PresentationHandle: "88888888-8888-4888-8888-888888888888",
			PresentationSHA256: fmt.Sprintf("%x", presentationHash), PresentationSchemaVersion: timeline.SchemaVersion, PresentationProfileVersion: timeline.Initial.Profile.Version,
			PresentationDurationMillis: timeline.Clock.DurationMillis, KeyHandle: "99999999-9999-4999-8999-999999999999", ObjectHandle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		},
		EnvelopeDigest: make([]byte, sha256.Size), LeaseToken: "lease-token", LeaseOwner: "render-worker", LeaseExpiresAt: now.Add(30 * time.Minute),
	}
	authority, err := renderAuthorityFromClaim(claim, now)
	if err != nil {
		t.Fatal(err)
	}
	keyHandle := mustRenderAttemptID(t, claim.Envelope.KeyHandle)
	input := recordingrender.ResolvedInput{
		SchemaVersion: recordingrender.InputSchemaVersion, TranscriptionMode: mode,
		TenantID: authority.TenantID, SpaceID: authority.SpaceID, EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID,
		CaptureEpoch: timeline.Clock.CaptureEpoch, CaptureReadyAt: now.Add(-time.Minute), DurationMillis: timeline.Clock.DurationMillis,
		Presentation:       recordingrender.DownloadableObject{ObjectFacts: recordingrender.ObjectFacts{ObjectKey: "recordings/test/presentation.json", ObjectETag: "etag", ContentType: "application/json", ByteSize: int64(len(presentation)), SHA256: append([]byte(nil), presentationHash[:]...)}, Download: recordingrender.DownloadGrant{ExpiresAt: now.Add(time.Hour)}},
		PresentationHandle: mustRenderAttemptID(t, claim.Envelope.PresentationHandle), PresentationSchemaVersion: timeline.SchemaVersion, PresentationProfileVersion: timeline.Initial.Profile.Version, PresentationSHA256: append([]byte(nil), presentationHash[:]...),
		Capture: []recordingrender.DownloadableCaptureObject{{CaptureObject: recordingrender.CaptureObject{ObjectFacts: recordingrender.ObjectFacts{ObjectKey: "recordings/test/000.bundle", ObjectETag: "etag", ContentType: "application/octet-stream", ByteSize: 1, SHA256: bytes.Repeat([]byte{0x01}, sha256.Size)}, CaptureEpoch: timeline.Clock.CaptureEpoch, CaptureJobID: mustRenderAttemptID(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), KeyHandle: keyHandle, EnvelopeDigest: bytes.Repeat([]byte{0x02}, sha256.Size), SequenceNumber: 0}, Download: recordingrender.DownloadGrant{ExpiresAt: now.Add(time.Hour)}}},
	}
	decode := &transcriptionAttemptDecode{}
	control := &transcriptionAttemptControl{input: input, presentation: presentation, keyHandle: keyHandle, commitErr: commitErr}
	attempt := &ProductionRenderAttempt{config: ProductionRenderAttemptConfig{Control: control, WorkRoot: t.TempDir(), Environment: "test", Commands: transcriptionAttemptCommands{}, Decode: decode.write, Now: func() time.Time { return now }}, claim: claim, authority: authority, workspace: t.TempDir()}
	return attempt, control, decode
}

func pointerString(value string) *string {
	return &value
}
