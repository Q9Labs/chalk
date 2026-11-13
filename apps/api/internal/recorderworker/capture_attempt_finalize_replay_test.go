package recorderworker

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureBundleWriterCommitsUploadAcceptedBeforeCanceledResponse(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	storage := newCaptureFinalizeReplayStorage(t, now)
	storage.acceptFirstUpload = true
	writer := newCaptureFinalizeReplayWriter(t, now, storage)

	uploadCtx, cancelUpload := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { first <- writer.persist(uploadCtx) }()
	select {
	case <-storage.firstUploadStarted:
	case <-time.After(time.Second):
		t.Fatal("first upload did not reach the accepted-response boundary")
	}
	cancelUpload()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("ambiguous upload error = %v", err)
	}
	if err := writer.persist(context.Background()); err != nil {
		t.Fatalf("commit accepted upload: %v", err)
	}
	if storage.uploadCalls != 1 || storage.commitCalls != 2 || storage.repository.finalizeCalls != 1 {
		t.Fatalf("upload/commit/finalize calls = %d/%d/%d, want 1/2/1", storage.uploadCalls, storage.commitCalls, storage.repository.finalizeCalls)
	}
}

func newCaptureFinalizeReplayWriter(t *testing.T, now time.Time, storage *captureFinalizeReplayStorage) *captureBundleWriter {
	t.Helper()
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{
			TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"), CaptureEpoch: 1, AttemptCount: 1, FencingGeneration: 1,
			Envelope: recordingpipeline.RecorderJobEnvelope{BundleSchemaVersion: recordingpipeline.RecordingBundleSchema, KeyHandle: "key-handle", ObjectHandle: "77777777-7777-4777-8777-777777777777"}, EnvelopeDigest: bytesOf(0x42),
		},
		lease: capturesignaling.WorkerLease{Owner: "worker", Token: "lease", ExpiresAt: now.Add(time.Minute)},
		keys:  storage, objects: storage, bundles: storage,
		config: CaptureAttemptConfig{Now: func() time.Time { return now }}.normalized(),
	}
	writer := newCaptureBundleWriter(attempt)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	activateCaptureTestTrack(writer, track, now, 1)
	if err := writer.addPacket(context.Background(), track, &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Timestamp: 100}, Payload: []byte{1}}, now.Add(time.Millisecond)); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	if err := writer.assembler.Close(recordingbundle.CloseReasonCadence, 1, 1); err != nil {
		t.Fatalf("close assembler: %v", err)
	}
	return writer
}

type captureFinalizeReplayStorage struct {
	service            recordingobjects.Service
	repository         *captureFinalizeReplayRepository
	firstUploadStarted chan struct{}
	firstCommitStarted chan struct{}
	uploadBodies       [][]byte
	uploadCalls        int
	commitCalls        int
	objectPresent      bool
	objectCommitted    bool
	blockFirstUpload   bool
	acceptFirstUpload  bool
	cancelFirstCommit  bool
}

func (s *captureFinalizeReplayStorage) AccessKey(context.Context, CaptureKeyRequest) (CaptureDataKey, error) {
	return CaptureDataKey{Plaintext: bytesOf(0x41), EncryptionContextDigest: bytesOf(0xcd)}, nil
}

func (s *captureFinalizeReplayStorage) Reserve(_ context.Context, input BundleReserveRequest) (BundleReservation, error) {
	const allocationID = "88888888-8888-4888-8888-888888888888"
	authority := captureFinalizeReplayAuthority(input)
	s.repository.allocation = recordingobjects.Allocation{
		ID: allocationID, ReservationRequestID: input.ReservationRequestID, AllocationVersion: 1,
		Authority: authority, SequenceNumber: 0, State: "reserved",
		ObjectKey:               fmt.Sprintf("temporary/recordings/%s/capture/%d/bundles/0/%s.bundle", input.RecordingID, input.CaptureEpoch, allocationID),
		EncryptionContextDigest: append([]byte(nil), input.EncryptionContextDigest...),
	}
	return BundleReservation{ReservationID: allocationID, Sequence: 0, AllocationVersion: 1, ObjectKey: s.repository.allocation.ObjectKey}, nil
}

func (s *captureFinalizeReplayStorage) Finalize(ctx context.Context, input CaptureBundleFinalize) (CaptureBundleUpload, error) {
	checksum, err := hex.DecodeString(input.ObjectSHA256)
	if err != nil {
		return CaptureBundleUpload{}, err
	}
	manifest := input.Bundle.Manifest
	result, err := s.service.Finalize(ctx, recordingobjects.FinalizeInput{
		Authority: captureFinalizeReplayAuthority(input.Authority), AllocationID: input.Reservation.ReservationID,
		ExpectedByteSize: input.ObjectSize, ExpectedChecksumSHA256: checksum, ContentType: input.ContentType,
		Codec: input.Codec, Layer: input.Layer,
		MonotonicStartMillis: manifest.MonotonicRange.StartMilliseconds, MonotonicEndMillis: manifest.MonotonicRange.EndMilliseconds,
		MediaStartMillis: manifest.MediaRange.StartMilliseconds, MediaEndMillis: manifest.MediaRange.EndMilliseconds,
	})
	if err != nil {
		return CaptureBundleUpload{}, err
	}
	return CaptureBundleUpload{Reservation: input.Reservation, UploadToken: result.UploadToken, SignedURL: result.UploadURL}, nil
}

func (s *captureFinalizeReplayStorage) Upload(ctx context.Context, input CaptureObjectUpload) error {
	s.uploadCalls++
	s.uploadBodies = append(s.uploadBodies, append([]byte(nil), input.Body...))
	if s.uploadCalls == 1 && s.blockFirstUpload {
		if s.acceptFirstUpload {
			s.objectPresent = true
		}
		close(s.firstUploadStarted)
		<-ctx.Done()
		return ctx.Err()
	}
	s.objectPresent = true
	return nil
}

func (s *captureFinalizeReplayStorage) Commit(ctx context.Context, _ CaptureBundleCommit) error {
	s.commitCalls++
	if s.objectCommitted {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !s.objectPresent {
		return ErrControlPlaneRetryable
	}
	s.objectCommitted = true
	if s.cancelFirstCommit {
		s.cancelFirstCommit = false
		close(s.firstCommitStarted)
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
}

func captureFinalizeReplayAuthority(input BundleReserveRequest) recordingobjects.Authority {
	return recordingobjects.Authority{
		TenantID: input.TenantID, EpisodeID: input.EpisodeID, RecordingID: input.RecordingID, JobID: input.JobID, ObjectHandle: input.ObjectHandle,
		AttemptCount: input.Attempt, FencingGeneration: input.FencingGeneration, CaptureEpoch: int64(input.CaptureEpoch), EnvelopeDigest: mustDecodeCaptureDigest(input.EnvelopeDigest),
		LeaseToken: input.LeaseToken, LeaseOwner: input.LeaseOwner, LeaseExpiresAt: input.LeaseExpiresAt,
	}
}

func mustDecodeCaptureDigest(value string) []byte {
	digest, _ := hex.DecodeString(value)
	return digest
}

type captureFinalizeReplayRepository struct {
	allocation    recordingobjects.Allocation
	finalizeCalls int
}

func (*captureFinalizeReplayRepository) Authorize(context.Context, recordingobjects.Authority) error {
	return nil
}

func (*captureFinalizeReplayRepository) BundleSchema(context.Context, recordingobjects.Authority) (string, error) {
	return recordingbundle.Version, nil
}

func (*captureFinalizeReplayRepository) ReserveAllocation(context.Context, recordingobjects.ReserveInput) (recordingobjects.Allocation, error) {
	return recordingobjects.Allocation{}, recordingobjects.ErrRepositoryUnavailable
}

func (*captureFinalizeReplayRepository) GetAllocationByReservationRequest(context.Context, string) (recordingobjects.Allocation, error) {
	return recordingobjects.Allocation{}, recordingobjects.ErrAllocationNotFound
}

func (r *captureFinalizeReplayRepository) FinalizeAllocation(_ context.Context, allocation recordingobjects.Allocation) error {
	r.finalizeCalls++
	r.allocation = allocation
	return nil
}

func (r *captureFinalizeReplayRepository) GetAllocation(context.Context, string) (recordingobjects.Allocation, error) {
	return r.allocation, nil
}

func (*captureFinalizeReplayRepository) GetAllocationByTokenHash(context.Context, []byte) (recordingobjects.Allocation, error) {
	return recordingobjects.Allocation{}, recordingobjects.ErrAllocationNotFound
}

func (*captureFinalizeReplayRepository) CreateAllocation(context.Context, recordingobjects.Allocation) error {
	return recordingobjects.ErrRepositoryUnavailable
}

func (*captureFinalizeReplayRepository) CommitAllocation(context.Context, recordingobjects.Allocation, objectstorage.ObjectFacts, []byte, time.Time) (recordingobjects.Bundle, error) {
	return recordingobjects.Bundle{}, recordingobjects.ErrRepositoryUnavailable
}

type captureFinalizeReplayStore struct {
	now time.Time
}

func (*captureFinalizeReplayStore) PutObject(context.Context, objectstorage.PutObjectInput) (objectstorage.Object, error) {
	return objectstorage.Object{}, nil
}

func (*captureFinalizeReplayStore) GetObject(context.Context, string) (objectstorage.ObjectReader, error) {
	return objectstorage.ObjectReader{}, nil
}

func (*captureFinalizeReplayStore) InspectObject(context.Context, string) (objectstorage.ObjectFacts, error) {
	return objectstorage.ObjectFacts{}, nil
}

func (*captureFinalizeReplayStore) DeleteObject(context.Context, string) error {
	return nil
}

func (s *captureFinalizeReplayStore) CreateUploadURL(context.Context, objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{Method: "PUT", URL: "https://storage.test/upload", ExpiresAt: s.now.Add(time.Minute)}, nil
}

func (*captureFinalizeReplayStore) CreateDownloadURL(context.Context, objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, nil
}

func (*captureFinalizeReplayStore) CreateDeleteURL(context.Context, objectstorage.CreateDeleteURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, nil
}

type captureCloseBudgetStorage struct {
	captureTestStorage
	perBundleCost  time.Duration
	closeBudget    time.Duration
	closeSpent     time.Duration
	runningUploads int
	closeUploads   int
}

func (s *captureCloseBudgetStorage) Upload(ctx context.Context, input CaptureObjectUpload) error {
	s.mu.Lock()
	if _, closing := ctx.Deadline(); closing {
		s.closeUploads++
		s.closeSpent += s.perBundleCost
		if s.closeSpent > s.closeBudget {
			s.mu.Unlock()
			return context.DeadlineExceeded
		}
	} else {
		s.runningUploads++
	}
	s.mu.Unlock()
	return s.captureTestStorage.Upload(ctx, input)
}
