package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"

	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
)

func (attempt *ProductionRenderAttempt) persistTranscription(ctx context.Context, input recordingrender.ResolvedInput, timeline recordingpresentation.Timeline, decodedRoot string, index recordingdecode.Index) (*recordingrender.TranscriptionSource, error) {
	authority := attempt.currentAuthority()
	sources := make([]recordingdecode.Source, 0)
	for _, source := range index.Sources {
		if source.Kind == "microphone" {
			sources = append(sources, source)
		}
	}
	if len(sources) == 0 {
		return nil, nil
	}
	sort.Slice(sources, func(i, j int) bool {
		if sources[i].StartMS != sources[j].StartMS {
			return sources[i].StartMS < sources[j].StartMS
		}
		return sources[i].SourceID < sources[j].SourceID
	})
	plannedChunks := int64(0)
	for _, source := range sources {
		plannedChunks += (source.EndMS - source.StartMS + TranscriptionChunkMaximumMillis - 1) / TranscriptionChunkMaximumMillis
		if plannedChunks > recordingrender.MaximumTranscriptionChunks {
			return nil, fmt.Errorf("%w: recording transcription chunk count exceeds bound", ErrInvalidProductionRenderAttempt)
		}
	}
	chunks := make([]recordingrender.TranscriptionChunk, 0)
	for _, source := range sources {
		for chunkStart := source.StartMS; chunkStart < source.EndMS; chunkStart += TranscriptionChunkMaximumMillis {
			chunkEnd := chunkStart + TranscriptionChunkMaximumMillis
			if chunkEnd > source.EndMS {
				chunkEnd = source.EndMS
			}
			indexValue := len(chunks)
			chunkPath := filepath.Join(attempt.workspace, fmt.Sprintf("transcription-%05d.flac", indexValue))
			sourceOffset := chunkStart - source.StartMS
			plan, err := BuildTranscriptionAudioPlan(filepath.Join(decodedRoot, filepath.FromSlash(source.Path)), chunkPath, sourceOffset, chunkEnd-chunkStart)
			if err != nil {
				return nil, fmt.Errorf("plan recording transcription chunk %d: %w", indexValue, err)
			}
			if _, err := RenderTranscriptionAudio(ctx, attempt.config.Commands, plan); err != nil {
				return nil, fmt.Errorf("render recording transcription chunk %d: %w", indexValue, err)
			}
			duration := chunkEnd - chunkStart
			object, err := attempt.persistFile(ctx, recordingrender.PurposeTranscriptionAudio, fmt.Sprintf("audio:%s:%d:%d", source.SourceID, chunkStart, chunkEnd), chunkPath, &duration)
			if err != nil {
				return nil, err
			}
			chunks = append(chunks, recordingrender.TranscriptionChunk{
				ChunkID: deterministicRenderID(authority, "chunk:"+source.SourceID+":"+strconv.FormatInt(chunkStart, 10)+":"+strconv.FormatInt(chunkEnd, 10)),
				Index:   indexValue, Generation: authority.FencingGeneration, StartMillis: chunkStart, EndMillis: chunkEnd,
				SourceStartMillis: sourceOffset, SourceEndMillis: sourceOffset + duration,
				ParticipantRef: source.ParticipantID, ParticipantGeneration: source.ParticipantGeneration,
				DisplayNameSnapshot: participantDisplayNameAt(timeline, source.ParticipantID, chunkStart), TrackID: source.TrackID,
				TrackEpoch: strconv.FormatInt(source.TrackEpoch, 10), IdentityKind: "participant", TrackClass: "microphone",
				Overlap: microphoneOverlap(sources, source.SourceID, chunkStart, chunkEnd), Object: object,
			})
		}
	}
	manifestBytes, manifestSHA, err := MarshalTranscriptionSourceManifest(attempt.currentAuthority(), input.PresentationSHA256, input.DurationMillis, chunks)
	if err != nil {
		return nil, fmt.Errorf("build recording transcription source: %w", err)
	}
	manifestPath := filepath.Join(attempt.workspace, "transcription-source.json")
	if err := os.WriteFile(manifestPath, manifestBytes, 0o600); err != nil {
		return nil, fmt.Errorf("write recording transcription source: %w", err)
	}
	manifest, err := attempt.persistFile(ctx, recordingrender.PurposeTranscriptionManifest, "transcription-manifest", manifestPath, nil)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(manifest.Object.SHA256, manifestSHA) {
		return nil, fmt.Errorf("%w: transcription source digest drift", ErrInvalidProductionRenderAttempt)
	}
	return &recordingrender.TranscriptionSource{SchemaVersion: recordingrender.TranscriptionSourceSchemaVersion, PresentationSHA256: append([]byte(nil), input.PresentationSHA256...), Manifest: manifest, Chunks: chunks}, nil
}

func (attempt *ProductionRenderAttempt) persistFile(ctx context.Context, purpose recordingrender.ObjectPurpose, stableName, path string, duration *int64) (recordingrender.CommitObjectReference, error) {
	info, err := os.Stat(path)
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("inspect recording render object %s: %w", purpose, err)
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("%w: recording render object %s is not a non-empty regular file", ErrInvalidProductionRenderAttempt, purpose)
	}
	file, err := os.Open(path)
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("open recording render object %s: %w", purpose, err)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		_ = file.Close()
		return recordingrender.CommitObjectReference{}, fmt.Errorf("hash recording render object %s: %w", purpose, err)
	}
	if err := file.Close(); err != nil {
		return recordingrender.CommitObjectReference{}, err
	}
	checksum := hash.Sum(nil)
	authority := attempt.currentAuthority()
	reserved, err := retryRenderAuthority(ctx, attempt, "reserve_object", func(ctx context.Context, current recordingrender.Authority) (recordingrender.ReservedObject, error) {
		return attempt.config.Control.ReserveRenderObject(ctx, recordingrender.ReserveObjectInput{
			Authority: current, Purpose: purpose, ReservationRequestID: deterministicRenderID(authority, "reserve:"+string(purpose)+":"+stableName),
		})
	})
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("reserve recording render object %s: %w", purpose, err)
	}
	contentType := map[recordingrender.ObjectPurpose]string{
		recordingrender.PurposeRecordingVideo: "video/mp4", recordingrender.PurposeTranscriptionAudio: "audio/flac", recordingrender.PurposeTranscriptionManifest: "application/json",
	}[purpose]
	finalized, err := retryRenderAuthority(ctx, attempt, "finalize_object", func(ctx context.Context, authority recordingrender.Authority) (recordingrender.FinalizedObject, error) {
		return attempt.config.Control.FinalizeRenderObject(ctx, recordingrender.FinalizeObjectInput{
			Authority: authority, AllocationID: reserved.AllocationID, Purpose: purpose, ContentType: contentType,
			ByteSize: info.Size(), SHA256: checksum, DurationMillis: duration,
		})
	})
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("finalize recording render object %s: %w", purpose, err)
	}
	if finalized.AllocationID != reserved.AllocationID || finalized.ObjectKey != reserved.ObjectKey || finalized.Purpose != purpose || finalized.AllocationVersion != reserved.AllocationVersion {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("%w: finalized recording render object changed its reservation", ErrInvalidProductionRenderAttempt)
	}
	// Conditional PUT cannot overwrite an uploaded object. If a response was lost,
	// a repeated PUT may return 412; the commit below verifies all stored facts.
	retriedUpload := false
	_, err = retryRenderCall(ctx, attempt, "upload_object", func(ctx context.Context) (struct{}, error) {
		file, openErr := os.Open(path)
		if openErr != nil {
			return struct{}{}, openErr
		}
		uploadErr := attempt.config.Control.UploadRenderObject(ctx, finalized.Upload, file, info.Size())
		closeErr := file.Close()
		var httpErr HTTPError
		if retriedUpload && errors.As(uploadErr, &httpErr) && httpErr.Status == http.StatusPreconditionFailed {
			uploadErr = nil
		}
		if errors.Is(uploadErr, ErrControlPlaneRetryable) {
			retriedUpload = true
		}
		return struct{}{}, errors.Join(uploadErr, closeErr)
	})
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("upload recording render object %s: %w", purpose, err)
	}
	committed, err := retryRenderAuthority(ctx, attempt, "commit_object", func(ctx context.Context, authority recordingrender.Authority) (recordingrender.CommittedObject, error) {
		return attempt.config.Control.CommitRenderObject(ctx, recordingrender.CommitObjectInput{Authority: authority, AllocationID: reserved.AllocationID, UploadToken: finalized.UploadToken})
	})
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("commit recording render object %s: %w", purpose, err)
	}
	if committed.AllocationID != reserved.AllocationID || committed.Object.ObjectKey != reserved.ObjectKey || committed.Purpose != purpose || committed.AllocationVersion != reserved.AllocationVersion || committed.Object.ContentType != contentType || committed.Object.ByteSize != info.Size() || !bytes.Equal(committed.Object.SHA256, checksum) || !equalRenderDuration(committed.DurationMillis, duration) {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("%w: committed recording render object facts changed", ErrInvalidProductionRenderAttempt)
	}
	return recordingrender.CommitObjectReference{AllocationID: committed.AllocationID, Purpose: purpose, Object: committed.Object, DurationMillis: committed.DurationMillis}, nil
}
